import { Router } from 'express';
import { all, get, run } from '../db.js';
import { requireAuth, requireApproved, passengerIfSignedIn } from '../auth.js';
import {
  ApiError, assertTransition, integerInRange, normalizeRwandaPhone, oneOf, parseNear, text,
} from '../validate.js';
import { journeyDistance } from '../osm.js';
import { fareFor, FARE_RULE } from '../fares.js';
import { shapePayment } from './payments.js';

const router = Router();
const KINDS = ['ride', 'delivery'];

export const shapeRequest = (row) => ({
  id: row.id,
  driverId: row.driver_id,
  passengerId: row.passenger_id ?? null,
  clientName: row.client_name,
  clientPhone: row.client_phone,
  kind: row.kind,
  origin: row.origin,
  destination: row.destination,
  scheduledAt: row.scheduled_at,
  passengers: row.passengers,
  note: row.note,
  status: row.status,
  distanceKm: row.distance_km,
  distanceSource: row.distance_source,
  fareRwf: row.fare_rwf,
  fareBasis: row.fare_basis,
  createdAt: row.created_at,
});

const driverSummary = (row) => row && ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  plate: row.plate,
  vehicleType: row.vehicle_type,
  pricePerKm: row.price_per_km,
  online: Boolean(row.is_online),
  onTrip: Boolean(row.on_trip),
  state: row.on_trip ? 'with_passenger' : (row.is_online ? 'available' : 'offline'),
});

/* Motorcycles are priced by the regulator's table; cars and taxis keep their own rate. */
const priceTrip = (driver, distanceKm) => {
  const priced = fareFor(distanceKm, driver.vehicle_type, driver.price_per_km);
  return {
    fareRwf: priced.fareRwf,
    components: priced.components,
    basis: driver.vehicle_type === 'moto' ? FARE_RULE : 'driver_rate',
  };
};

router.post('/api/requests', async (req, res) => {
  const driverId = integerInRange(req.body.driver_id, 'driver_id', 1, 1e9);
  const driver = await get('SELECT * FROM drivers WHERE id = ?', driverId);
  if (!driver) throw new ApiError(404, 'driver_not_found', 'That driver is no longer registered');
  if (driver.status !== 'approved') throw new ApiError(409, 'driver_unavailable', 'This driver is not active on SERE Moto');
  if (!driver.is_online) throw new ApiError(409, 'driver_offline', 'This driver is offline right now, pick another one');
  /* A rider already with a passenger cannot take a second booking, even if the app still lists them. */
  if (driver.on_trip) throw new ApiError(409, 'driver_busy', 'This rider is already carrying a passenger, pick another one');

  const kind = oneOf(req.body.kind, KINDS, 'kind');
  if (driver.services !== 'both' && driver.services !== kind) {
    throw new ApiError(409, 'service_not_offered', `This driver only offers ${driver.services}`);
  }

  const passengers = integerInRange(req.body.passengers ?? 1, 'passengers', 1, 8);
  if (passengers > driver.capacity) {
    throw new ApiError(409, 'capacity_exceeded', `This vehicle carries at most ${driver.capacity} passengers`);
  }

  const scheduled = req.body.scheduled_at ? text(req.body.scheduled_at, 'scheduled_at', { max: 40 }) : null;
  if (scheduled && Number.isNaN(Date.parse(scheduled))) {
    throw new ApiError(422, 'invalid_scheduled_at', 'scheduled_at must be an ISO date-time');
  }

  let distance = req.body.distance_km === undefined || req.body.distance_km === null || req.body.distance_km === ''
    ? null
    : Number(req.body.distance_km);
  if (distance !== null && (!Number.isFinite(distance) || distance <= 0 || distance > 300)) {
    throw new ApiError(422, 'invalid_distance_km', 'distance_km must be between 0 and 300');
  }
  let distanceSource = distance ? 'manual' : null;
  if (!distance) {
    /* The client's GPS fix picks the right one of the places that share a name. */
    const near = req.body.near ? parseNear(req.body.near) : null;
    const measured = await journeyDistance(req.body.origin, req.body.destination, near);
    if (measured) {
      distance = measured.distanceKm;
      distanceSource = measured.source;
    }
  }
  const priced = distance ? priceTrip(driver, distance) : { fareRwf: null, basis: null };

  const passenger = await passengerIfSignedIn(req);
  const clientPhone = normalizeRwandaPhone(passenger ? req.body.client_phone || passenger.phone : req.body.client_phone, 'client_phone');
  if (passenger && clientPhone !== passenger.phone) {
    throw new ApiError(403, 'phone_not_yours', 'A signed-in passenger books on their own verified number');
  }
  const clientName = text(req.body.client_name ?? passenger?.name ?? 'Guest', 'client_name', { max: 80 });

  const result = await run(
    `INSERT INTO ride_requests (driver_id, passenger_id, client_name, client_phone, kind, origin, destination, scheduled_at, passengers, note, distance_km, distance_source, fare_rwf, fare_basis)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    driverId,
    passenger ? passenger.id : null,
    clientName,
    clientPhone,
    kind,
    text(req.body.origin, 'origin', { max: 60 }),
    text(req.body.destination, 'destination', { max: 60 }),
    scheduled,
    passengers,
    req.body.note ? text(req.body.note, 'note', { max: 500 }) : null,
    distance,
    distanceSource,
    priced.fareRwf,
    priced.basis,
  );
  res.status(201).json({
    request: shapeRequest(await get('SELECT * FROM ride_requests WHERE id = ?', result.lastInsertRowid)),
    driver: driverSummary(driver),
    fare_components: priced.components,
  });
});

router.get('/api/requests/me', requireAuth, requireApproved, async (req, res) => {
  const rows = await all(
    'SELECT * FROM ride_requests WHERE driver_id = ? ORDER BY id DESC LIMIT 200',
    req.driverId,
  );
  res.json({ requests: rows.map(shapeRequest) });
});

router.get('/api/requests/:id', requireAuth, requireApproved, async (req, res) => {
  const id = integerInRange(req.params.id, 'id', 1, 1e9);
  const row = await get('SELECT * FROM ride_requests WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'request_not_found', 'No such request');
  if (row.driver_id !== req.driverId) throw new ApiError(403, 'forbidden', 'This request belongs to another driver');
  res.json({
    request: shapeRequest(row),
    payments: (await all('SELECT * FROM payments WHERE request_id = ? ORDER BY id DESC', id)).map(shapePayment),
  });
});

router.patch('/api/requests/:id/status', requireAuth, requireApproved, async (req, res) => {
  const id = integerInRange(req.params.id, 'id', 1, 1e9);
  const row = await get('SELECT * FROM ride_requests WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'request_not_found', 'No such request');
  if (row.driver_id !== req.driverId) throw new ApiError(403, 'forbidden', 'This request belongs to another driver');
  const status = oneOf(req.body.status, ['seen', 'accepted', 'declined', 'completed', 'cancelled'], 'status');
  assertTransition(row.status, status);

  const driver = await get('SELECT * FROM drivers WHERE id = ?', row.driver_id);
  if (status === 'accepted' && driver.on_trip) {
    throw new ApiError(409, 'driver_busy', 'This rider is already carrying a passenger. Finish that trip first.');
  }
  await run('UPDATE ride_requests SET status = ? WHERE id = ?', status, id);

  /* A rider carrying a passenger is not available; after the trip they say so themselves. */
  if (status === 'accepted') await run('UPDATE drivers SET on_trip = 1 WHERE id = ?', row.driver_id);
  if (status === 'completed') await run('UPDATE drivers SET on_trip = 0, is_online = 0 WHERE id = ?', row.driver_id);
  if (status === 'declined' || status === 'cancelled') await run('UPDATE drivers SET on_trip = 0 WHERE id = ?', row.driver_id);

  res.json({
    request: shapeRequest(await get('SELECT * FROM ride_requests WHERE id = ?', id)),
    driver: driverSummary(await get('SELECT * FROM drivers WHERE id = ?', row.driver_id)),
  });
});

export default router;
