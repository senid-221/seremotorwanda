import { Router } from 'express';
import { all, get, run } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import { config, storageConfigured } from '../config.js';
import {
  ApiError, integerInRange, normalizePlate, oneOf, text,
  divisionCode, language,
} from '../validate.js';
import { divisionBrief, isWithin, node } from '../locations.js';
import { checkPhone, verifyId, verifyTin } from '../kyc.js';
import { documentShape, presignDownload } from '../storage.js';
import { shapePayment } from './payments.js';

const router = Router();
const VEHICLE_TYPES = ['moto', 'car'];
const SERVICES = ['ride', 'delivery', 'both'];
const KINDS = ['ride', 'delivery'];
const STATUSES = ['pending', 'approved', 'rejected'];
const OPEN_TRIP = `('new','seen','accepted')`;
/* Everything the console reports is counted in Kigali time (UTC+2), not the server's UTC clock. */
const CAT = '+2 hours';

const adminShape = (row, lang = 'en') => ({
  id: row.id,
  name: row.name,
  /* An application is opened with an email now, so the console shows the address the rider signs in
     with — the public rider list never carries it. */
  email: row.email,
  phone: row.phone,
  plate: row.plate,
  vehicleType: row.vehicle_type,
  idNumber: row.id_number,
  tinNumber: row.tin_number,
  hasGoogle: Boolean(row.google_id),
  status: row.status,
  reason: row.review_reason,
  reviewedAt: row.reviewed_at,
  createdAt: row.created_at,
  zone: row.zone,
  area: row.loc_code ? divisionBrief(row.loc_code, lang) : null,
  around: row.live_code ? divisionBrief(row.live_code, lang) : null,
  locAt: row.loc_at || null,
  pricePerKm: row.price_per_km,
  services: row.services,
  capacity: row.capacity,
  online: Boolean(row.is_online),
  onTrip: Boolean(row.on_trip),
  isAdmin: Boolean(row.is_admin),
  rating: row.rating_count ? Math.round((row.rating_sum / row.rating_count) * 10) / 10 : 0,
  trips: row.rating_count,
  kyc: {
    tin: row.tin_status,
    id: row.id_status,
    phone: row.phone_status,
    at: row.kyc_at,
    taxpayer: row.tin_taxpayer || null,
    idName: row.id_name || null,
    operator: row.phone_operator || null,
  },
});

router.get('/api/admin/applications', requireAuth, requireAdmin, async (req, res) => {
  const status = req.query.status ? oneOf(req.query.status, STATUSES, 'status') : 'pending';
  const lang = language(req.query.lang);
  /* The stored verdict comes along from the check tables, so the queue shows what RRA and
     NIDA answered — not just that something was checked. */
  const rows = await all(
    `SELECT d.*, t.taxpayer AS tin_taxpayer, i.name AS id_name, p.operator AS phone_operator
       FROM drivers d
       LEFT JOIN tin_checks t ON t.tin = d.tin_number
       LEFT JOIN id_checks i ON i.id_number = d.id_number
       LEFT JOIN phone_checks p ON p.phone = d.phone
       WHERE d.status = ? ORDER BY d.id ASC LIMIT 500`,
    status,
  );
  res.json({ status, applications: rows.map((row) => adminShape(row, lang)) });
});

/* A check that was unavailable when the application was filed — an RRA outage, a provider
   added later — can be re-run here. The verdict is written back onto the application so the
   queue and this answer can never disagree. */
const KYC_CHECKS = ['tin', 'id', 'phone'];

router.post('/api/admin/applications/:id/verify', requireAuth, requireAdmin, async (req, res) => {
  const id = integerInRange(req.params.id, 'id', 1, 1e9);
  const check = oneOf(req.body.check, KYC_CHECKS, 'check');
  const row = await get('SELECT * FROM drivers WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'application_not_found', 'No such application');

  let state;
  if (check === 'tin') {
    if (!row.tin_number) throw new ApiError(422, 'invalid_tin_number', 'This application has no TIN to check.');
    state = (await verifyTin(row.tin_number, { force: true })).valid ? 'pass' : 'fail';
  } else if (check === 'id') {
    if (!row.id_number) throw new ApiError(422, 'invalid_id_number', 'This application has no ID number to check.');
    const result = await verifyId(row.id_number, row.name, { force: true });
    state = !result.exists ? 'fail' : (result.match ? 'pass' : 'fail');
  } else {
    state = (await checkPhone(row.phone, { force: true })).valid ? 'pass' : 'fail';
  }

  await run(`UPDATE drivers SET ${check}_status = ?, kyc_at = datetime('now') WHERE id = ?`, state, id);
  const fresh = await get(
    `SELECT d.*, t.taxpayer AS tin_taxpayer, i.name AS id_name, p.operator AS phone_operator
       FROM drivers d
       LEFT JOIN tin_checks t ON t.tin = d.tin_number
       LEFT JOIN id_checks i ON i.id_number = d.id_number
       LEFT JOIN phone_checks p ON p.phone = d.phone
       WHERE d.id = ?`, id,
  );
  res.json({ check, status: state, application: adminShape(fresh, language(req.query.lang)) });
});

router.post('/api/admin/applications/:id/decision', requireAuth, requireAdmin, async (req, res) => {
  const id = integerInRange(req.params.id, 'id', 1, 1e9);
  const action = oneOf(req.body.action, ['approve', 'reject'], 'action');
  const row = await get('SELECT * FROM drivers WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'application_not_found', 'No such application');
  if (row.status !== 'pending') {
    throw new ApiError(409, 'already_reviewed', `This application was already ${row.status}.`);
  }

  if (action === 'reject') {
    const reason = text(req.body.reason, 'reason', { min: 3, max: 300 });
    await run(`UPDATE drivers SET status = 'rejected', review_reason = ?, reviewed_at = datetime('now') WHERE id = ?`, reason, id);
    return res.json({ application: adminShape(await get('SELECT * FROM drivers WHERE id = ?', id)) });
  }

  const plate = req.body.plate !== undefined ? normalizePlate(req.body.plate) : row.plate;
  const vehicleType = req.body.vehicle_type !== undefined
    ? oneOf(req.body.vehicle_type, VEHICLE_TYPES, 'vehicle_type')
    : row.vehicle_type;
  const zone = req.body.zone !== undefined ? text(req.body.zone, 'zone', { max: 60 }) : row.zone;
  const services = req.body.services !== undefined ? oneOf(req.body.services, SERVICES, 'services') : row.services;
  const pricePerKm = req.body.price_per_km !== undefined
    ? integerInRange(req.body.price_per_km, 'price_per_km', 100, 2000)
    : row.price_per_km;
  const capacity = req.body.capacity !== undefined
    ? integerInRange(req.body.capacity, 'capacity', 1, 8)
    : (row.capacity ?? (vehicleType === 'car' ? 4 : 1));

  /* Motorcycles are priced by the RURA table, so an admin only needs a rate for cars and taxis. */
  const required = [['zone', zone], ['services', services]];
  if (vehicleType !== 'moto') required.push(['price_per_km', pricePerKm]);
  const missing = required
    .filter(([, value]) => value === null || value === undefined || value === '')
    .map(([key]) => key);
  if (missing.length) {
    throw new ApiError(422, 'incomplete_profile', `Ask the rider for: ${missing.join(', ')}`);
  }

  try {
    await run(
      `UPDATE drivers
       SET status = 'approved', review_reason = NULL, reviewed_at = datetime('now'),
           plate = ?, vehicle_type = ?, zone = ?, zones = ?, services = ?, price_per_km = ?, capacity = ?
       WHERE id = ?`,
      plate, vehicleType, zone, row.zones || JSON.stringify([zone]), services, pricePerKm, capacity, id,
    );
  } catch (error) {
    if (error.code === '23505' && String(error.constraint || '').includes('plate')) {
      throw new ApiError(409, 'plate_taken', 'That plate already belongs to another rider.');
    }
    throw error;
  }
  res.json({ application: adminShape(await get('SELECT * FROM drivers WHERE id = ?', id), language(req.query.lang)) });
});

const searchNeedle = (value) => (`%${String(value).toLowerCase().replace(/[%_]/g, '')}%`);

/* One query feeds both the riders table and the directory search, so the numbers always agree. */
const riderWork = `
       (SELECT COUNT(*) FROM ride_requests r WHERE r.driver_id = d.id AND r.status = 'completed')  AS trips_completed,
       (SELECT COUNT(*) FROM ride_requests r WHERE r.driver_id = d.id AND r.status IN ${OPEN_TRIP}) AS trips_open,
       (SELECT COALESCE(SUM(r.fare_rwf), 0) FROM ride_requests r
         WHERE r.driver_id = d.id AND r.status = 'completed')                                      AS gross_rwf,
       (SELECT COALESCE(SUM(p.driver_payout_rwf), 0) FROM payments p
         JOIN ride_requests r ON r.id = p.request_id
        WHERE r.driver_id = d.id AND p.status = 'paid')                                           AS payout_rwf`;

router.get('/api/admin/riders', requireAuth, requireAdmin, async (req, res) => {
  const where = ['1 = 1'];
  const params = [];
  const lang = language(req.query.lang);
  if (req.query.status) { where.push('d.status = ?'); params.push(oneOf(req.query.status, STATUSES, 'status')); }
  if (req.query.vehicle_type) { where.push('d.vehicle_type = ?'); params.push(oneOf(req.query.vehicle_type, VEHICLE_TYPES, 'vehicle_type')); }
  if (String(req.query.online || '') === '1') where.push('d.is_online = 1');
  if (req.query.q) {
    where.push('(LOWER(d.name) LIKE ? OR d.phone LIKE ? OR LOWER(d.plate) LIKE ? OR LOWER(d.zone) LIKE ?)');
    const needle = searchNeedle(req.query.q);
    params.push(needle, needle, needle, needle);
  }
  /* Same rule the booking page uses: a rider belongs to a division where they work or where they
     were last seen. The tree is in memory, so one code at any level is a post-filter, not SQL. */
  let divisionNode = null;
  if (req.query.division) {
    divisionNode = node(divisionCode(req.query.division, 'division'));
    if (!divisionNode) throw new ApiError(404, 'division_not_found', 'No Rwandan division carries that code.');
  }
  let rows = await all(
    `SELECT d.*, ${riderWork} FROM drivers d WHERE ${where.join(' AND ')}
      ORDER BY d.is_online DESC, trips_completed DESC, d.id ASC LIMIT 300`,
    ...params,
  );
  if (divisionNode) {
    const within = (code) => code && isWithin(code, divisionNode.code);
    rows = rows.filter((row) => within(row.loc_code) || within(row.live_code));
  }
  res.json({
    riders: rows.map((row) => ({
      ...adminShape(row, lang),
      tripsCompleted: row.trips_completed, tripsOpen: row.trips_open,
      grossRwf: row.gross_rwf, payoutRwf: row.payout_rwf,
    })),
    division: divisionNode
      ? { code: divisionNode.code, name: lang === 'rw' ? divisionNode.nameRw : divisionNode.name, riders: rows.length }
      : null,
  });
});

/* The console's levers on a rider: pull them off the road, bring them back, or drop a stale session. */
router.get('/api/admin/riders/:id/documents', requireAuth, requireAdmin, async (req, res) => {
  const id = integerInRange(req.params.id, 'id', 1, 1e9);
  if (!(await get('SELECT id FROM drivers WHERE id = ?', id))) {
    throw new ApiError(404, 'application_not_found', 'No such application');
  }
  const rows = await all('SELECT * FROM driver_documents WHERE driver_id = ? ORDER BY kind', id);
  const signed = storageConfigured();
  const documents = await Promise.all(rows.map(async (row) => ({
    ...documentShape(row),
    url: signed && row.status === 'uploaded' ? await presignDownload(row.object_key) : null,
  })));
  res.json({ configured: signed, documents });
});

router.post('/api/admin/riders/:id/action', requireAuth, requireAdmin, async (req, res) => {
  const id = integerInRange(req.params.id, 'id', 1, 1e9);
  const action = oneOf(req.body.action, ['suspend', 'reinstate', 'offline'], 'action');
  const row = await get('SELECT * FROM drivers WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'rider_not_found', 'No such rider');
  if (action !== 'offline' && row.is_admin) {
    throw new ApiError(409, 'cannot_modify_admin', 'An admin account cannot be suspended or reinstated');
  }
  let cancelledTrips = 0;
  if (action === 'suspend') {
    if (row.status === 'rejected') throw new ApiError(409, 'already_suspended', 'This rider is already suspended');
    const reason = req.body.reason ? text(req.body.reason, 'reason', { max: 300 }) : 'Suspended by a SERE Moto admin';
    await run(`UPDATE drivers SET status = 'rejected', review_reason = ?, reviewed_at = datetime('now'),
                is_online = 0, on_trip = 0, lat = NULL, lng = NULL, loc_at = NULL WHERE id = ?`, reason, id);
    cancelledTrips = (await run(`UPDATE ride_requests SET status = 'cancelled' WHERE driver_id = ? AND status IN ${OPEN_TRIP}`, id)).changes;
  }
  if (action === 'reinstate') {
    if (row.status === 'approved') throw new ApiError(409, 'already_approved', 'This rider is already approved');
    await run(`UPDATE drivers SET status = 'approved', review_reason = NULL, reviewed_at = datetime('now') WHERE id = ?`, id);
  }
  if (action === 'offline') {
    await run(`UPDATE drivers SET is_online = 0, on_trip = 0, lat = NULL, lng = NULL, loc_at = NULL WHERE id = ?`, id);
    cancelledTrips = (await run(`UPDATE ride_requests SET status = 'cancelled' WHERE driver_id = ? AND status IN ${OPEN_TRIP}`, id)).changes;
  }
  res.json({ rider: adminShape(await get('SELECT * FROM drivers WHERE id = ?', id), language(req.query.lang)), cancelledTrips });
});

const tripRow = (row) => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  origin: row.origin,
  destination: row.destination,
  distanceKm: row.distance_km,
  fareRwf: row.fare_rwf,
  scheduledAt: row.scheduled_at,
  createdAt: row.created_at,
  clientName: row.client_name,
  clientPhone: row.client_phone,
  passengerId: row.passenger_id,
  rated: Boolean(row.rated),
  paymentStatus: row.payment_status,
  collectedRwf: row.collected_rwf,
  driver: {
    id: row.driver_id, name: row.driver_name, phone: row.driver_phone, plate: row.plate,
    vehicleType: row.vehicle_type, zone: row.zone, online: Boolean(row.driver_online), onTrip: Boolean(row.driver_on_trip),
  },
});

const tripColumns = `
  SELECT r.*, d.name AS driver_name, d.phone AS driver_phone, d.plate, d.vehicle_type, d.zone,
         d.is_online AS driver_online, d.on_trip AS driver_on_trip,
         (SELECT tr.id FROM trip_ratings tr WHERE tr.request_id = r.id) AS rated,
         (SELECT p.status FROM payments p WHERE p.request_id = r.id
           ORDER BY (p.status = 'paid') DESC, p.id DESC LIMIT 1) AS payment_status,
         (SELECT COALESCE(SUM(p.amount_rwf), 0) FROM payments p
           WHERE p.request_id = r.id AND p.status = 'paid') AS collected_rwf
    FROM ride_requests r JOIN drivers d ON d.id = r.driver_id`;

router.get('/api/admin/trips', requireAuth, requireAdmin, async (req, res) => {
  const scope = oneOf(req.query.scope || 'all', ['active', 'history', 'all'], 'scope');
  const limit = integerInRange(req.query.limit ?? 80, 'limit', 1, 300);
  const where = ['1 = 1'];
  const params = [];
  if (scope === 'active') where.push(`r.status IN ${OPEN_TRIP}`);
  if (scope === 'history') where.push(`r.status IN ('completed','cancelled','declined')`);
  if (req.query.kind) { where.push('r.kind = ?'); params.push(oneOf(req.query.kind, KINDS, 'kind')); }
  if (req.query.driver_id) { where.push('r.driver_id = ?'); params.push(integerInRange(req.query.driver_id, 'driver_id', 1, 1e9)); }
  if (req.query.q) {
    where.push('(LOWER(r.client_name) LIKE ? OR r.client_phone LIKE ? OR LOWER(r.origin) LIKE ? OR LOWER(r.destination) LIKE ? OR LOWER(d.plate) LIKE ?)');
    const needle = searchNeedle(req.query.q);
    params.push(needle, needle, needle, needle, needle);
  }
  const rows = await all(
    `${tripColumns} WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ?`,
    ...params, limit,
  );
  res.json({ scope, trips: rows.map(tripRow) });
});

router.post('/api/admin/trips/:id/cancel', requireAuth, requireAdmin, async (req, res) => {
  const id = integerInRange(req.params.id, 'id', 1, 1e9);
  const row = await get('SELECT * FROM ride_requests WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'trip_not_found', 'No such trip');
  if (!['new', 'seen', 'accepted'].includes(row.status)) {
    throw new ApiError(409, 'not_cancellable', `This trip is already ${row.status}`);
  }
  await run(`UPDATE ride_requests SET status = 'cancelled' WHERE id = ?`, id);
  if (row.status === 'accepted') await run('UPDATE drivers SET on_trip = 0 WHERE id = ?', row.driver_id);
  res.json({ trip: tripRow(await get(`${tripColumns} WHERE r.id = ?`, id)) });
});

router.get('/api/admin/payments', requireAuth, requireAdmin, async (req, res) => {
  const limit = integerInRange(req.query.limit ?? 80, 'limit', 1, 300);
  const where = ['1 = 1'];
  const params = [];
  if (req.query.status) { where.push('p.status = ?'); params.push(oneOf(req.query.status, ['pending', 'paid', 'failed', 'refunded'], 'status')); }
  if (req.query.provider) { where.push('p.provider = ?'); params.push(String(req.query.provider)); }
  if (req.query.q) {
    where.push('(p.provider_reference LIKE ? OR p.payer_phone LIKE ? OR LOWER(p.payer_email) LIKE ?)');
    const needle = searchNeedle(req.query.q);
    params.push(needle, needle, needle);
  }
  const rows = await all(
    `SELECT p.*, r.driver_id, r.client_name FROM payments p JOIN ride_requests r ON r.id = p.request_id
      WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT ?`,
    ...params, limit,
  );
  res.json({
    payments: rows.map((row) => ({ ...shapePayment(row), clientName: row.client_name, driverId: row.driver_id })),
    totals: await get(
      `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_rwf END), 0)        AS collected_rwf,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN platform_fee_rwf END), 0)  AS fee_rwf,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN driver_payout_rwf END), 0) AS payout_rwf,
              COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_rwf END), 0)     AS open_rwf
         FROM payments`,
    ),
  });
});

router.get('/api/admin/passengers', requireAuth, requireAdmin, async (req, res) => {
  const limit = integerInRange(req.query.limit ?? 100, 'limit', 1, 300);
  const where = ['1 = 1'];
  const params = [];
  if (req.query.q) {
    where.push('(LOWER(p.name) LIKE ? OR p.phone LIKE ? OR LOWER(p.email) LIKE ?)');
    const needle = searchNeedle(req.query.q);
    params.push(needle, needle, needle);
  }
  const rows = await all(
    `SELECT p.*,
            (SELECT COUNT(*) FROM ride_requests r WHERE r.passenger_id = p.id) AS trips,
            (SELECT COALESCE(SUM(r.fare_rwf), 0) FROM ride_requests r
              WHERE r.passenger_id = p.id AND r.status = 'completed') AS spent_rwf,
            (SELECT COUNT(*) FROM passenger_places pp WHERE pp.passenger_id = p.id) AS places
       FROM passengers p WHERE ${where.join(' AND ')}
      ORDER BY trips DESC, p.id DESC LIMIT ?`,
    ...params, limit,
  );
  res.json({
    passengers: rows.map((row) => ({
      id: row.id, name: row.name, phone: row.phone, email: row.email,
      createdAt: row.created_at, lastLoginAt: row.last_login_at,
      trips: row.trips, spentRwf: row.spent_rwf, places: row.places,
    })),
  });
});

router.get('/api/admin/stats', requireAuth, requireAdmin, async (_req, res) => {
  const drivers = await get(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
            COUNT(*) FILTER (WHERE status = 'approved') AS approved,
            COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
       FROM drivers`,
  );
  const activity = await get(
    `SELECT COUNT(*) AS requests,
            COUNT(*) FILTER (WHERE status = 'new')       AS open,
            COUNT(*) FILTER (WHERE status = 'completed') AS completed,
            COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
            COUNT(*) FILTER (WHERE status = 'declined')  AS declined,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN fare_rwf ELSE 0 END), 0) AS "fareRwf"
       FROM ride_requests`,
  );
  const money = await get(
    `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_rwf END), 0)        AS collected_rwf,
            COALESCE(SUM(CASE WHEN status = 'paid' THEN platform_fee_rwf END), 0)  AS fee_rwf,
            COALESCE(SUM(CASE WHEN status = 'paid' THEN driver_payout_rwf END), 0) AS payout_rwf,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_rwf END), 0)     AS open_rwf,
            COUNT(*) FILTER (WHERE status = 'paid')    AS paid,
            COUNT(*) FILTER (WHERE status = 'pending') AS pending
       FROM payments`,
  );
  const today = await get(
    `SELECT COUNT(*) AS trips,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN fare_rwf END), 0) AS gross_rwf
       FROM ride_requests WHERE datetime(created_at, '${CAT}') >= datetime('now', '${CAT}', 'start of day')`,
  );
  const stars = await get('SELECT COALESCE(ROUND(AVG(stars), 1), 0) AS average, COUNT(*) AS count FROM trip_ratings');
  res.json({
    commissionPercent: config.commissionPercent,
    drivers: {
      ...drivers,
      online: (await get(`SELECT COUNT(*) AS count FROM drivers WHERE status = 'approved' AND is_online = 1`)).count,
      withPassenger: (await get(`SELECT COUNT(*) AS count FROM drivers WHERE status = 'approved' AND on_trip = 1`)).count,
    },
    requests: {
      total: activity.requests || 0,
      open: activity.open,
      completed: activity.completed,
      cancelled: activity.cancelled,
      declined: activity.declined,
      fareRwf: activity.fareRwf,
    },
    today,
    payments: {
      paid: money.paid, pending: money.pending,
      collectedRwf: money.collected_rwf, commissionRwf: money.fee_rwf,
      driverPayoutRwf: money.payout_rwf, openRwf: money.open_rwf,
    },
    passengers: {
      accounts: (await get('SELECT COUNT(*) AS count FROM passengers')).count,
      places: (await get('SELECT COUNT(*) AS count FROM passenger_places')).count,
      ratings: stars.count,
      averageStars: stars.average,
    },
  });
});

/* The charts on the console's overview tab: a 7-day series plus zone, provider and rider breakdowns. */
router.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
  const lang = language(req.query.lang);
  const since = (await get(`SELECT datetime('now', '${CAT}', 'start of day', '-6 days') AS t`)).t;
  const daily = await all(
    `SELECT to_char(r.created_at::timestamp + interval '${CAT}', 'YYYY-MM-DD') AS day,
            COUNT(*) AS trips,
            COALESCE(SUM(CASE WHEN r.status = 'completed' THEN r.fare_rwf END), 0) AS gross_rwf,
            COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.platform_fee_rwf END), 0) AS fee_rwf
       FROM ride_requests r LEFT JOIN payments p ON p.request_id = r.id AND p.status = 'paid'
      WHERE datetime(r.created_at, '${CAT}') >= ?
      GROUP BY day ORDER BY day ASC`,
    since,
  );
  /* The seven days come from the start date already read above, so no date() call is needed. */
  const start = Date.parse(`${since.replace(' ', 'T')}Z`);
  const series = [];
  for (let step = 0; step < 7; step += 1) {
    const day = new Date(start + step * 86_400_000).toISOString().slice(0, 10);
    const found = daily.find((row) => row.day === day);
    series.push({ day, trips: found?.trips || 0, grossRwf: found?.gross_rwf || 0, feeRwf: found?.fee_rwf || 0 });
  }
  res.json({
    series,
    byZone: await all(
      `SELECT COALESCE(NULLIF(d.zone, ''), '—') AS zone, COUNT(*) AS trips,
              COALESCE(SUM(r.fare_rwf), 0) AS gross_rwf
         FROM ride_requests r JOIN drivers d ON d.id = r.driver_id
        WHERE r.status = 'completed' GROUP BY zone ORDER BY gross_rwf DESC LIMIT 12`,
    ),
    byProvider: await all(
      `SELECT provider, status, COUNT(*) AS count, COALESCE(SUM(amount_rwf), 0) AS rwf
         FROM payments GROUP BY provider, status ORDER BY provider, status`,
    ),
    byKind: await all(
      `SELECT kind, COUNT(*) AS count, COALESCE(SUM(CASE WHEN status = 'completed' THEN fare_rwf END), 0) AS gross_rwf
         FROM ride_requests GROUP BY kind`,
    ),
    topRiders: (await all(
      `SELECT d.id, d.name, d.plate, d.zone, d.loc_code, COUNT(r.id) AS trips,
              COALESCE(SUM(r.fare_rwf), 0) AS gross_rwf
         FROM ride_requests r JOIN drivers d ON d.id = r.driver_id
        WHERE r.status = 'completed'
        GROUP BY d.id ORDER BY gross_rwf DESC LIMIT 8`,
    )).map((row) => ({ ...row, area: row.loc_code ? divisionBrief(row.loc_code, lang) : null })),
    webhooks: await get(
      `SELECT COUNT(*) AS received,
              COUNT(*) FILTER (WHERE error IS NOT NULL) AS failed
         FROM webhook_events`,
    ),
  });
});

export default router;
