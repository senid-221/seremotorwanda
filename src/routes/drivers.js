import { Router } from 'express';
import { all, get, run } from '../db.js';
import { requireAuth, requireApproved } from '../auth.js';
import { config, storageConfigured } from '../config.js';
import { pointDistanceKm } from '../osm.js';
import { fareFor, FARE_RULE } from '../fares.js';
import {
  areaOf, chain, divisionAt, divisionBrief, isWithin, label, levelKey, node,
} from '../locations.js';
import { shapeRequest } from './requests.js';
import {
  DOCUMENT_KINDS, DOCUMENT_TYPES_BY_KIND, documentKey, documentShape, documentTypesFor, acceptsType,
  headObject, presignDownload, presignUpload,
} from '../storage.js';
import {
  ApiError, normalizePlate, text, oneOf, integerInRange, stringList,
  latitude, longitude, numberInRange, parseNear, divisionCode, language,
} from '../validate.js';

const router = Router();
const VEHICLE_TYPES = ['moto', 'car'];
const SERVICES = ['ride', 'delivery', 'both'];
const SLOTS = ['morning', 'afternoon', 'evening', 'weekend'];

const secondsSince = (iso) => {
  if (!iso) return null;
  const stamp = Date.parse(`${iso.replace(' ', 'T')}Z`);
  return Number.isNaN(stamp) ? null : Math.max(0, Math.round((Date.now() - stamp) / 1000));
};

const uniqueConflict = (error) => {
  if (!error || error.code !== '23505') throw error;
  const constraint = String(error.constraint || '');
  if (constraint.includes('phone')) throw new ApiError(409, 'phone_taken', 'This phone number is already registered.');
  if (constraint.includes('id_number')) throw new ApiError(409, 'id_number_taken', 'This national ID is already registered.');
  if (constraint.includes('tin_number')) throw new ApiError(409, 'tin_number_taken', 'This TIN is already registered.');
  throw new ApiError(409, 'plate_taken', 'This plate number is already registered.');
};

/* The free-text zone label the older screens still show, built from the picked division. */
const zoneLabel = (code) => {
  const walk = chain(code);
  const leaf = walk[walk.length - 1];
  const parent = walk.length > 1 ? walk[walk.length - 2] : null;
  const text = parent ? `${leaf.name}, ${parent.name}` : leaf.name;
  return text.length <= 60 ? text : leaf.name.slice(0, 60);
};

/* One picked code becomes the leaf plus the three shallow ancestors, so filtering by district in SQL
   is a column test rather than a tree walk per request. */
const applyDivision = (profile, raw) => {
  const code = divisionCode(raw);
  if (!node(code)) {
    throw new ApiError(404, 'division_not_found', 'No Rwandan division carries that code.');
  }
  const area = areaOf(code);
  profile.loc_code = area.code;
  profile.loc_level = area.level;
  profile.province_code = area.province;
  profile.district_code = area.district;
  profile.sector_code = area.sector;
  profile.zone = zoneLabel(code);
};

/* Two divisions travel with every rider row: the one they said they work in, and the one their last
   fix fell in — the second only ever "around", because the seed holds a centre point per sector. */
export const shape = (row, near, lang = 'en') => {
  const locAge = secondsSince(row.loc_at);
  const live = Boolean(row.is_online) && locAge !== null && locAge <= config.liveLocationSeconds;
  const state = row.on_trip ? 'with_passenger' : (row.is_online ? 'available' : 'offline');
  const around = row.live_code ? divisionBrief(row.live_code, lang) : null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    plate: row.plate,
    vehicleType: row.vehicle_type,
    status: row.status,
    reason: row.review_reason,
    isAdmin: Boolean(row.is_admin),
    zone: row.zone,
    zones: JSON.parse(row.zones),
    area: row.loc_code ? divisionBrief(row.loc_code, lang) : null,
    around: live ? around : null,
    aroundApproximate: true,
    pricePerKm: row.price_per_km,
    fareBasis: row.vehicle_type === 'moto' ? FARE_RULE : (row.price_per_km ? 'driver_rate' : null),
    services: row.services,
    capacity: row.capacity,
    availableSlots: JSON.parse(row.available_slots),
    online: Boolean(row.is_online),
    onTrip: Boolean(row.on_trip),
    state,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    locAgeSeconds: locAge,
    live,
    distanceKm: near && row.lat !== null && row.lng !== null
      ? pointDistanceKm(near, { lat: row.lat, lng: row.lng })
      : null,
    rating: row.rating_count ? Math.round((row.rating_sum / row.rating_count) * 10) / 10 : 0,
    trips: row.rating_count,
    createdAt: row.created_at,
  };
};

const profileFrom = (body, { partial = false } = {}) => {
  const profile = {};
  if (!partial || body.name !== undefined) profile.name = text(body.name, 'name', { max: 80 });
  if (!partial || body.plate !== undefined) profile.plate = normalizePlate(body.plate);
  if (!partial || body.vehicle_type !== undefined) profile.vehicle_type = oneOf(body.vehicle_type, VEHICLE_TYPES, 'vehicle_type');
  if (!partial || body.zone !== undefined) profile.zone = text(body.zone, 'zone', { max: 60 });
  if (!partial || body.price_per_km !== undefined) profile.price_per_km = integerInRange(body.price_per_km, 'price_per_km', 100, 2000);
  if (!partial || body.services !== undefined) profile.services = oneOf(body.services, SERVICES, 'services');
  if (body.capacity !== undefined) profile.capacity = integerInRange(body.capacity, 'capacity', 1, 8);
  if (body.zones !== undefined) profile.zones = JSON.stringify(stringList(body.zones, 'zones'));
  /* The dropdowns send one code — the deepest division the rider actually chose. */
  if (body.location_code !== undefined && body.location_code !== null && String(body.location_code) !== '') {
    applyDivision(profile, body.location_code);
  }
  if (body.available_slots !== undefined) {
    const slots = stringList(body.available_slots, 'available_slots', { max: 4 });
    const unknown = slots.filter((slot) => !SLOTS.includes(slot));
    if (unknown.length) throw new ApiError(422, 'invalid_available_slots', `available_slots must be from: ${SLOTS.join(', ')}`);
    profile.available_slots = JSON.stringify(slots);
  }
  return profile;
};

router.get('/api/drivers', async (req, res) => {
  const { q, zone, division, vehicle_type: type, service, online, available, near, max_km: maxKm } = req.query;
  const lang = language(req.query.lang);
  /* Motorcycles are priced by the regulator's table, so only cars still need a rate on file. */
  const where = ["drivers.status = 'approved'", "(vehicle_type = 'moto' OR price_per_km IS NOT NULL)"];
  const params = [];
  if (type) { where.push('vehicle_type = ?'); params.push(oneOf(type, VEHICLE_TYPES, 'vehicle_type')); }
  if (zone) {
    const wanted = String(zone).toLowerCase();
    where.push('(LOWER(zone) = ? OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(drivers.zones::jsonb) AS entry WHERE LOWER(entry) = ?))');
    params.push(wanted, wanted);
  }
  /* One division code at any level: a rider belongs to it if that is where they work or where they
     were last seen. The tree is small and in memory, so this is a post-filter, not a SQL predicate. */
  let divisionNode = null;
  if (division) {
    const code = divisionCode(division, 'division');
    divisionNode = node(code);
    if (!divisionNode) throw new ApiError(404, 'division_not_found', 'No Rwandan division carries that code.');
  }
  if (service) {
    const wanted = oneOf(service, SERVICES, 'service');
    where.push(wanted === 'both' ? 'services = ?' : '(services = ? OR services = ?)');
    params.push(...(wanted === 'both' ? ['both'] : [wanted, 'both']));
  }
  if (String(online || '') === '1' || online === true) where.push('is_online = 1');
  if (String(available || '') === '1' || available === true) where.push('is_online = 1 AND on_trip = 0');
  if (q) {
    const needle = `%${String(q).toLowerCase().replace(/[%_]/g, '')}%`;
    where.push('(LOWER(name) LIKE ? OR LOWER(plate) LIKE ? OR LOWER(zones) LIKE ? OR LOWER(zone) LIKE ?)');
    params.push(needle, needle, needle, needle);
  }
  const sql = `SELECT * FROM drivers WHERE ${where.join(' AND ')}
               ORDER BY is_online DESC, (rating_sum * 1.0 / GREATEST(rating_count, 1)) DESC, rating_count DESC, id ASC
               LIMIT 200`;
  let rows = await all(sql, ...params);
  /* A rider belongs to a division if that is where they work or where they were last seen. */
  if (divisionNode) {
    const within = (code) => code && isWithin(code, divisionNode.code);
    rows = rows.filter((row) => within(row.loc_code) || within(row.live_code));
  }

  let origin = null;
  if (near) origin = parseNear(near);
  let drivers = rows.map((row) => shape(row, origin, lang));
  if (origin) {
    const limit = maxKm === undefined ? 20 : numberInRange(maxKm, 'max_km', 0.2, 200);
    const rank = (d) => (d.online ? 0 : 2) + (d.live ? 0 : 1);
    drivers = drivers
      .filter((d) => d.distanceKm !== null && d.distanceKm <= limit)
      .sort((a, b) => rank(a) - rank(b) || a.distanceKm - b.distanceKm);
  }
  res.json({
    drivers,
    division: divisionNode ? {
      code: divisionNode.code,
      levelKey: levelKey(divisionNode.level),
      name: lang === 'rw' ? divisionNode.nameRw : divisionNode.name,
      label: label(divisionNode.code, lang),
      riders: drivers.length,
    } : null,
    near: origin ? { lat: origin.lat, lng: origin.lng, max_km: maxKm === undefined ? 20 : Number(maxKm) } : null,
  });
});

router.get('/api/zones', async (_req, res) => {
  const zones = new Set();
  const rows = await all(`SELECT zone, zones FROM drivers WHERE status = 'approved'`);
  for (const row of rows) {
    if (row.zone) zones.add(row.zone);
    for (const extra of JSON.parse(row.zones)) zones.add(extra);
  }
  res.json({ zones: [...zones].sort((a, b) => a.localeCompare(b)) });
});

router.get('/api/drivers/me', requireAuth, async (req, res) => {
  res.json({ driver: shape(await get('SELECT * FROM drivers WHERE id = ?', req.driverId), null, language(req.query.lang)) });
});

// A pending rider fills in their own operating details so the admin only has to review and approve.
router.patch('/api/drivers/me', requireAuth, async (req, res) => {
  const profile = profileFrom(req.body, { partial: true });
  const keys = Object.keys(profile);
  if (!keys.length) throw new ApiError(422, 'empty_update', 'Send at least one field to update');
  if (profile.zone && profile.zones === undefined) {
    const current = await get('SELECT zones FROM drivers WHERE id = ?', req.driverId);
    profile.zones = JSON.stringify([...new Set(JSON.parse(current.zones || '[]').concat(profile.zone))]);
  }
  try {
    await run(`UPDATE drivers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => profile[k]), req.driverId);
  } catch (error) {
    uniqueConflict(error);
  }
  res.json({ driver: shape(await get('SELECT * FROM drivers WHERE id = ?', req.driverId), null, language(req.query.lang)) });
});

router.post('/api/drivers/me/complete', requireAuth, async (req, res) => {
  const profile = profileFrom(req.body);
  if (!profile.zone && !profile.loc_code) {
    throw new ApiError(422, 'invalid_zone', 'Pick the division you work in, or type a zone.');
  }
  const columns = { ...profile, zones: profile.zones || JSON.stringify([profile.zone || profile.loc_code]) };
  if (columns.capacity === undefined) columns.capacity = profile.vehicle_type === 'car' ? 4 : 1;
  if (columns.available_slots === undefined) columns.available_slots = '[]';
  const keys = Object.keys(columns);
  await run(`UPDATE drivers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    ...keys.map((k) => columns[k]), req.driverId);
  res.json({ driver: shape(await get('SELECT * FROM drivers WHERE id = ?', req.driverId), null, language(req.query.lang)) });
});

/* A rider uploads their ID, licence and plate photos straight to the bucket. The API signs each PUT,
   then confirms the object is really there before marking the document uploaded. */
router.get('/api/drivers/me/documents', requireAuth, async (req, res) => {
  const rows = await all('SELECT * FROM driver_documents WHERE driver_id = ? ORDER BY kind', req.driverId);
  const signed = storageConfigured();
  const documents = await Promise.all(rows.map(async (row) => ({
    ...documentShape(row),
    url: signed && row.status === 'uploaded' ? await presignDownload(row.object_key) : null,
  })));
  res.json({ configured: signed, maxBytes: config.storage.maxUploadBytes, documentTypes: DOCUMENT_TYPES_BY_KIND, documents });
});

router.post('/api/drivers/me/documents/:kind/upload-url', requireAuth, async (req, res) => {
  const kind = oneOf(req.params.kind, DOCUMENT_KINDS, 'kind');
  const contentType = String(req.body.content_type || '').toLowerCase();
  if (!acceptsType(kind, contentType)) {
    throw new ApiError(422, 'unsupported_document_type', `A ${kind.replace(/_/g, ' ')} must be ${documentTypesFor(kind).join(', ')}`);
  }
  if (!storageConfigured()) {
    throw new ApiError(503, 'storage_not_configured', 'Document storage is not configured on this server');
  }
  if (!(await get('SELECT id FROM drivers WHERE id = ?', req.driverId))) {
    throw new ApiError(401, 'authentication_required', 'Sign in again to continue');
  }

  const key = documentKey(req.driverId, kind);
  const uploadUrl = await presignUpload(key, contentType);
  await run(
    `INSERT INTO driver_documents (driver_id, kind, object_key, content_type, bytes, status)
     VALUES (?, ?, ?, ?, 0, 'pending')
     ON CONFLICT (driver_id, kind) DO UPDATE SET object_key = excluded.object_key,
       content_type = excluded.content_type, bytes = 0, status = 'pending',
       note = NULL, uploaded_at = NULL`,
    req.driverId, kind, key, contentType,
  );

  res.json({
    kind,
    key,
    uploadUrl,
    contentType,
    expiresIn: config.storage.signedUrlTtlSeconds,
    maxBytes: config.storage.maxUploadBytes,
  });
});

router.post('/api/drivers/me/documents/:kind/complete', requireAuth, async (req, res) => {
  const kind = oneOf(req.params.kind, DOCUMENT_KINDS, 'kind');
  const row = await get('SELECT * FROM driver_documents WHERE driver_id = ? AND kind = ?', req.driverId, kind);
  if (!row) throw new ApiError(404, 'document_not_started', 'Ask for an upload URL before confirming the file.');

  const head = await headObject(row.object_key);
  if (!head) throw new ApiError(409, 'document_not_uploaded', 'The file is not in storage yet. Upload it, then try again.');
  if (!acceptsType(kind, head.contentType)) {
    throw new ApiError(422, 'unsupported_document_type', `A ${kind.replace(/_/g, ' ')} must be ${documentTypesFor(kind).join(', ')}`);
  }
  if (head.bytes > config.storage.maxUploadBytes) {
    throw new ApiError(413, 'document_too_large', `Keep the file under ${Math.round(config.storage.maxUploadBytes / 1048576)} MB.`);
  }

  await run(
    `UPDATE driver_documents SET status = 'uploaded', bytes = ?, content_type = ?,
       uploaded_at = datetime('now'), note = NULL WHERE id = ?`,
    head.bytes, head.contentType, row.id,
  );
  const fresh = await get('SELECT * FROM driver_documents WHERE id = ?', row.id);
  res.json({ document: { ...documentShape(fresh), url: await presignDownload(fresh.object_key) } });
});

router.post('/api/drivers/me/online', requireAuth, requireApproved, async (req, res) => {
  if (req.body.online === undefined) throw new ApiError(422, 'invalid_online', 'online must be true or false');
  const online = Boolean(req.body.online);
  if (online) {
    const missing = onlineBlockers(await get('SELECT * FROM drivers WHERE id = ?', req.driverId));
    if (missing.length) {
      throw new ApiError(409, 'profile_incomplete', `Add your ${missing.join(', ')} before going online.`);
    }
  }
  /* Going offline removes a rider from the live map; their last position is no longer advertised. */
  if (online) await run('UPDATE drivers SET is_online = 1 WHERE id = ?', req.driverId);
  else await run('UPDATE drivers SET is_online = 0, on_trip = 0, lat = NULL, lng = NULL, loc_at = NULL WHERE id = ?', req.driverId);
  res.json({ driver: shape(await get('SELECT * FROM drivers WHERE id = ?', req.driverId), null, language(req.query.lang)) });
});

/* A rider's own GPS fix, posted while the app is open so clients can see who is genuinely nearby.
   The fix also decides which sector the rider is standing in — a centroid match, so it says "around". */
router.post('/api/drivers/me/location', requireAuth, requireApproved, async (req, res) => {
  const lat = latitude(req.body.lat);
  const lng = longitude(req.body.lng);
  const accuracy = req.body.accuracy === undefined
    ? null
    : numberInRange(req.body.accuracy, 'accuracy', 1, 20000);
  if (!(await get('SELECT is_online FROM drivers WHERE id = ?', req.driverId))) {
    throw new ApiError(404, 'driver_not_found', 'No such driver');
  }
  const around = divisionAt(lat, lng);
  await run("UPDATE drivers SET lat = ?, lng = ?, loc_at = datetime('now'), live_code = ? WHERE id = ?",
    lat, lng, around ? around.code : null, req.driverId);
  res.json({
    driver: shape(await get('SELECT * FROM drivers WHERE id = ?', req.driverId), null, language(req.query.lang)),
    around: around ? { code: around.code, label: around.label, labelRw: around.labelRw, distanceKm: around.distanceKm, approximate: true } : null,
    accuracy_m: accuracy,
    live_within_seconds: config.liveLocationSeconds,
  });
});

/* SERE Moto works in Kigali, so trip days are counted in CAT (UTC+2), not the server's UTC clock. */
const CAT = '+2 hours';

const onlineBlockers = (row) => {
  const missing = [];
  /* A picked division covers the zone requirement; the free-text name is the older route to it. */
  if (!row.zone && !row.loc_code) missing.push('zone');
  if (!row.services) missing.push('services');
  if (row.vehicle_type !== 'moto' && !row.price_per_km) missing.push('price_per_km');
  return missing;
};

const cutoffs = () => get(
  `SELECT datetime('now', '${CAT}', 'start of day')    AS today,
          datetime('now', '${CAT}', 'start of day', '-6 days') AS week,
          datetime('now', '${CAT}', 'start of month')  AS month`,
);
const completedIn = (driverId, from) => get(
  `SELECT COUNT(*)                            AS trips,
          COALESCE(SUM(r.fare_rwf), 0)         AS gross_rwf,
          COALESCE(SUM(COALESCE(r.distance_km, 0)), 0) AS distance_km
     FROM ride_requests r
    WHERE r.driver_id = ? AND r.status = 'completed' AND datetime(r.created_at, '${CAT}') >= ?`,
  driverId, from,
);

const collectedIn = (driverId, from) => get(
  `SELECT COUNT(*)                                AS paid,
          COALESCE(SUM(p.amount_rwf), 0)          AS collected_rwf,
          COALESCE(SUM(p.driver_payout_rwf), 0)   AS payout_rwf,
          COALESCE(SUM(p.platform_fee_rwf), 0)    AS fee_rwf
     FROM payments p JOIN ride_requests r ON r.id = p.request_id
    WHERE r.driver_id = ? AND p.status = 'paid' AND datetime(p.created_at, '${CAT}') >= ?`,
  driverId, from,
);

const tripTotals = (driverId) => get(
  `SELECT COALESCE(SUM(CASE WHEN status = 'new'       THEN 1 ELSE 0 END), 0) AS awaiting,
          COALESCE(SUM(CASE WHEN status = 'seen'      THEN 1 ELSE 0 END), 0) AS seen,
          COALESCE(SUM(CASE WHEN status = 'accepted'  THEN 1 ELSE 0 END), 0) AS running,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
          COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
          COALESCE(SUM(CASE WHEN status = 'declined'  THEN 1 ELSE 0 END), 0) AS declined
     FROM ride_requests WHERE driver_id = ?`,
  driverId,
);

router.get('/api/drivers/me/requests', requireAuth, requireApproved, async (req, res) => {
  const scope = oneOf(req.query.scope || 'active', ['active', 'history', 'all'], 'scope');
  const limit = integerInRange(req.query.limit ?? 100, 'limit', 1, 200);
  const filter = {
    active: `AND status IN ('new','seen','accepted')`,
    history: `AND status IN ('completed','cancelled','declined')`,
    all: '',
  }[scope];
  const rows = await all(
    `SELECT *, (SELECT p.status FROM payments p WHERE p.request_id = ride_requests.id
                 ORDER BY (p.status = 'paid') DESC, p.id DESC LIMIT 1) AS payment_status
       FROM ride_requests WHERE driver_id = ? ${filter} ORDER BY id DESC LIMIT ?`,
    req.driverId, limit,
  );
  res.json({
    requests: rows.map((row) => ({ ...shapeRequest(row), paymentStatus: row.payment_status || null })),
    totals: await tripTotals(req.driverId),
  });
});

router.get('/api/drivers/me/stats', requireAuth, requireApproved, async (req, res) => {
  const driver = await get('SELECT * FROM drivers WHERE id = ?', req.driverId);
  const { today, week, month } = await cutoffs();
  const period = async (from) => ({ ...(await completedIn(req.driverId, from)), ...(await collectedIn(req.driverId, from)) });
  const counts = await all('SELECT stars, COUNT(*) AS count FROM trip_ratings WHERE driver_id = ? GROUP BY stars', req.driverId);
  const rated = counts.reduce((sum, row) => sum + row.count, 0);
  const average = rated
    ? Math.round((counts.reduce((sum, row) => sum + row.stars * row.count, 0) / rated) * 10) / 10
    : driver.rating_count ? Math.round((driver.rating_sum / driver.rating_count) * 10) / 10 : 0;
  res.json({
    driver: shape(driver, null, language(req.query.lang)),
    commissionPercent: config.commissionPercent,
    can_go_online: onlineBlockers(driver).length === 0,
    periods: { today: await period(today), week: await period(week), month: await period(month) },
    totals: await tripTotals(req.driverId),
    rating: {
      average,
      count: driver.rating_count,
      withComments: (await get('SELECT COUNT(*) AS count FROM trip_ratings WHERE driver_id = ? AND comment IS NOT NULL', req.driverId)).count,
      distribution: [5, 4, 3, 2, 1].map((stars) => ({
        stars,
        count: counts.find((row) => row.stars === stars)?.count || 0,
      })),
    },
    unbilled: await get(
      `SELECT COUNT(*) AS trips, COALESCE(SUM(r.fare_rwf), 0) AS rwf
         FROM ride_requests r LEFT JOIN payments p ON p.request_id = r.id AND p.status = 'paid'
        WHERE r.driver_id = ? AND r.status = 'completed' AND p.id IS NULL`,
      req.driverId,
    ),
  });
});

router.get('/api/drivers/me/ratings', requireAuth, requireApproved, async (req, res) => {
  const limit = integerInRange(req.query.limit ?? 30, 'limit', 1, 100);
  res.json({
    ratings: await all(
      `SELECT tr.stars, tr.comment, tr.created_at, r.id AS request_id, r.kind, r.origin, r.destination, r.fare_rwf,
              COALESCE(NULLIF(p.name, ''), r.client_name) AS passenger_name
         FROM trip_ratings tr
         JOIN ride_requests r ON r.id = tr.request_id
         LEFT JOIN passengers p ON p.id = tr.passenger_id
        WHERE tr.driver_id = ? ORDER BY tr.id DESC LIMIT ?`,
      req.driverId, limit,
    ),
  });
});

/* NDITEGUYE: finish the previous trip, show on the map again, and start receiving requests. */
router.post('/api/drivers/me/ready', requireAuth, requireApproved, async (req, res) => {
  const row = await get('SELECT * FROM drivers WHERE id = ?', req.driverId);
  const missing = onlineBlockers(row);
  if (missing.length) {
    throw new ApiError(409, 'profile_incomplete', `Add your ${missing.join(', ')} before going online.`);
  }
  await run('UPDATE drivers SET on_trip = 0, is_online = 1 WHERE id = ?', req.driverId);
  res.json({ driver: shape(await get('SELECT * FROM drivers WHERE id = ?', req.driverId), null, language(req.query.lang)) });
});

router.post('/api/drivers/:id/rating', async (req, res) => {
  const driverId = integerInRange(req.params.id, 'id', 1, 1e9);
  if (!(await get(`SELECT id FROM drivers WHERE id = ? AND status = 'approved'`, driverId))) {
    throw new ApiError(404, 'driver_not_found', 'No such driver');
  }
  const stars = integerInRange(req.body.stars, 'stars', 1, 5);
  await run('UPDATE drivers SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE id = ?', stars, driverId);
  res.json({ driver: shape(await get('SELECT * FROM drivers WHERE id = ?', driverId), null, language(req.query.lang)) });
});

export default router;
