import { Router } from 'express';
import { all, get, run } from '../db.js';
import { requirePassenger, signToken } from '../auth.js';
import { assertVerifyBudget, requireRealPhone } from '../kyc.js';
import { shapePayment } from './payments.js';
import {
  ApiError, integerInRange, normalizeRwandaPhone, numberInRange, text,
} from '../validate.js';

const router = Router();

const CANCELLABLE = ['new', 'seen', 'accepted'];
const TRIP_SCOPES = {
  active: "AND status IN ('new','seen','accepted')",
  history: "AND status IN ('completed','cancelled','declined')",
  all: '',
};

const passengerShape = (row) => ({
  id: row.id,
  phone: row.phone,
  name: row.name,
  email: row.email,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
});

/* The rider card a passenger needs to recognise the moto at the pickup point. */
const riderShape = (row) => row && ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  plate: row.plate,
  vehicleType: row.vehicle_type,
  zone: row.zone,
  online: Boolean(row.is_online),
  onTrip: Boolean(row.on_trip),
  rating: row.rating_count ? Math.round((row.rating_sum / row.rating_count) * 10) / 10 : 0,
  trips: row.rating_count,
});

const shapePlace = (row) => ({
  id: row.id,
  label: row.label,
  address: row.address,
  lat: row.lat ?? null,
  lng: row.lng ?? null,
});

const tripShape = async (row) => {
  const payment = await get('SELECT * FROM payments WHERE request_id = ? ORDER BY id DESC LIMIT 1', row.id);
  const rating = await get('SELECT * FROM trip_ratings WHERE request_id = ?', row.id);
  return {
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    destination: row.destination,
    status: row.status,
    passengers: row.passengers,
    note: row.note,
    scheduledAt: row.scheduled_at,
    distanceKm: row.distance_km,
    distanceSource: row.distance_source,
    fareRwf: row.fare_rwf,
    fareBasis: row.fare_basis,
    createdAt: row.created_at,
    rider: riderShape(await get('SELECT * FROM drivers WHERE id = ?', row.driver_id)),
    payment: payment ? shapePayment(payment) : null,
    rating: rating ? { stars: rating.stars, comment: rating.comment, createdAt: rating.created_at } : null,
    cancellable: CANCELLABLE.includes(row.status),
    payable: row.status === 'accepted' || row.status === 'completed',
    rateable: row.status === 'completed' && !rating,
  };
};

const ownTrip = async (passengerId, id) => {
  const requestId = integerInRange(id, 'id', 1, 1e9);
  const row = await get('SELECT * FROM ride_requests WHERE id = ?', requestId);
  if (!row) throw new ApiError(404, 'trip_not_found', 'No such trip');
  if (row.passenger_id !== passengerId) throw new ApiError(403, 'forbidden', 'That trip belongs to another number');
  return row;
};

/* A number the numbering plan recognises is the whole sign-in: no password, no code, nothing to remember. */
router.post('/api/passenger/auth/verify', async (req, res) => {
  const phone = normalizeRwandaPhone(req.body.phone);
  assertVerifyBudget(phone, req.ip);
  await requireRealPhone(phone);

  const name = req.body.name ? text(req.body.name, 'name', { max: 80 }) : null;
  const row = await get('SELECT * FROM passengers WHERE phone = ?', phone);
  if (row) {
    await run("UPDATE passengers SET last_login_at = datetime('now'), name = COALESCE(?, name) WHERE id = ?", name, row.id);
  } else {
    await run("INSERT INTO passengers (phone, name, last_login_at) VALUES (?, ?, datetime('now'))", phone, name);
  }
  const passenger = await get('SELECT * FROM passengers WHERE phone = ?', phone);

  /* Trips booked as a guest before this account existed become visible as soon as the number proves itself. */
  await run('UPDATE ride_requests SET passenger_id = ? WHERE client_phone = ? AND passenger_id IS NULL', passenger.id, phone);

  res.json({
    token: signToken({ passengerId: passenger.id }),
    passenger: passengerShape(passenger),
    trips: (await get('SELECT COUNT(*) AS count FROM ride_requests WHERE passenger_id = ?', passenger.id)).count,
  });
});

router.get('/api/passenger/me', requirePassenger, async (req, res) => {
  const stats = await get(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status IN ('new','seen','accepted')) AS active,
            COUNT(*) FILTER (WHERE status = 'completed')               AS completed,
            COUNT(*) FILTER (WHERE status = 'cancelled')               AS cancelled,
            COUNT(*) FILTER (WHERE status = 'declined')                AS declined,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN fare_rwf ELSE 0 END), 0) AS "spentRwf"
       FROM ride_requests WHERE passenger_id = ?`,
    req.passenger.id,
  );
  res.json({
    passenger: {
      ...passengerShape(await get('SELECT * FROM passengers WHERE id = ?', req.passenger.id)),
      places: (await all('SELECT * FROM passenger_places WHERE passenger_id = ? ORDER BY label', req.passenger.id)).map(shapePlace),
    },
    stats: {
      total: stats.total || 0,
      active: stats.active || 0,
      completed: stats.completed || 0,
      cancelled: stats.cancelled || 0,
      declined: stats.declined || 0,
      spentRwf: stats.spentRwf || 0,
      ratingsGiven: (await get('SELECT COUNT(*) AS count FROM trip_ratings WHERE passenger_id = ?', req.passenger.id)).count,
    },
  });
});

router.patch('/api/passenger/me', requirePassenger, async (req, res) => {
  const fields = {};
  if (req.body.name !== undefined) fields.name = text(req.body.name, 'name', { max: 80 });
  if (req.body.email !== undefined) fields.email = req.body.email ? text(req.body.email, 'email', { max: 120 }) : null;
  if (!Object.keys(fields).length) throw new ApiError(422, 'empty_update', 'Send at least one field to update');
  await run(`UPDATE passengers SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    ...Object.values(fields), req.passenger.id);
  res.json({ passenger: passengerShape(await get('SELECT * FROM passengers WHERE id = ?', req.passenger.id)) });
});

router.get('/api/passenger/trips', requirePassenger, async (req, res) => {
  const scope = TRIP_SCOPES[req.query.scope] ? req.query.scope : 'all';
  const limit = integerInRange(req.query.limit ?? 60, 'limit', 1, 200);
  const rows = await all(
    `SELECT * FROM ride_requests WHERE passenger_id = ? ${TRIP_SCOPES[scope]} ORDER BY id DESC LIMIT ${limit}`,
    req.passenger.id,
  );
  res.json({ scope, trips: await Promise.all(rows.map(tripShape)) });
});

router.get('/api/passenger/trips/:id', requirePassenger, async (req, res) => {
  res.json({ trip: await tripShape(await ownTrip(req.passenger.id, req.params.id)) });
});

router.post('/api/passenger/trips/:id/cancel', requirePassenger, async (req, res) => {
  const row = await ownTrip(req.passenger.id, req.params.id);
  if (!CANCELLABLE.includes(row.status)) {
    throw new ApiError(409, 'not_cancellable', `A ${row.status} trip can no longer be cancelled`);
  }
  await run("UPDATE ride_requests SET status = 'cancelled' WHERE id = ?", row.id);
  if (row.status === 'accepted') await run('UPDATE drivers SET on_trip = 0 WHERE id = ?', row.driver_id);
  res.json({ trip: await tripShape(await get('SELECT * FROM ride_requests WHERE id = ?', row.id)) });
});

/* One rating per finished trip; it also feeds the rider's public average. */
router.post('/api/passenger/trips/:id/rating', requirePassenger, async (req, res) => {
  const row = await ownTrip(req.passenger.id, req.params.id);
  if (row.status !== 'completed') throw new ApiError(409, 'not_completed', 'Only a finished trip can be rated');
  const stars = integerInRange(req.body.stars, 'stars', 1, 5);
  const comment = req.body.comment ? text(req.body.comment, 'comment', { max: 300 }) : null;
  if (await get('SELECT id FROM trip_ratings WHERE request_id = ?', row.id)) {
    throw new ApiError(409, 'already_rated', 'You already rated this trip');
  }
  await run('INSERT INTO trip_ratings (request_id, passenger_id, driver_id, stars, comment) VALUES (?, ?, ?, ?, ?)',
    row.id, req.passenger.id, row.driver_id, stars, comment);
  await run('UPDATE drivers SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE id = ?', stars, row.driver_id);
  res.json({ trip: await tripShape(await get('SELECT * FROM ride_requests WHERE id = ?', row.id)) });
});

router.get('/api/passenger/places', requirePassenger, async (req, res) => {
  res.json({ places: (await all('SELECT * FROM passenger_places WHERE passenger_id = ? ORDER BY label', req.passenger.id)).map(shapePlace) });
});

router.post('/api/passenger/places', requirePassenger, async (req, res) => {
  const label = text(req.body.label, 'label', { max: 40 });
  const address = text(req.body.address, 'address', { max: 120 });
  const lat = req.body.lat === undefined || req.body.lat === null || req.body.lat === '' ? null : numberInRange(req.body.lat, 'lat', -90, 90);
  const lng = req.body.lng === undefined || req.body.lng === null || req.body.lng === '' ? null : numberInRange(req.body.lng, 'lng', -180, 180);
  try {
    const inserted = await run(
      'INSERT INTO passenger_places (passenger_id, label, address, lat, lng) VALUES (?, ?, ?, ?, ?) RETURNING id',
      req.passenger.id, label, address, lat, lng,
    );
    res.status(201).json({ place: shapePlace(await get('SELECT * FROM passenger_places WHERE id = ?', inserted.lastInsertRowid)) });
  } catch (error) {
    if (error.code === '23505' && String(error.constraint || '').includes('passenger_places')) {
      throw new ApiError(409, 'place_exists', `You already saved a place called ${label}`);
    }
    throw error;
  }
});

router.delete('/api/passenger/places/:id', requirePassenger, async (req, res) => {
  const id = integerInRange(req.params.id, 'id', 1, 1e9);
  const row = await get('SELECT * FROM passenger_places WHERE id = ? AND passenger_id = ?', id, req.passenger.id);
  if (!row) throw new ApiError(404, 'place_not_found', 'No such saved place');
  await run('DELETE FROM passenger_places WHERE id = ?', id);
  res.json({ deleted: id });
});

export default router;
