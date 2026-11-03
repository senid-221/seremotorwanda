import { Router } from 'express';
import { journeyDistance } from '../osm.js';
import { fareFor } from '../fares.js';
import { ApiError, text, numberInRange, oneOf, parseNear } from '../validate.js';

const router = Router();

const VEHICLES = ['moto', 'car'];

/* Distance first: measured on real roads when OpenStreetMap can answer, otherwise the caller's own figure. */
router.get('/api/fare', async (req, res) => {
  const vehicle = oneOf(req.query.vehicle || 'moto', VEHICLES, 'vehicle');
  const waitMinutes = req.query.wait_minutes === undefined
    ? 0
    : numberInRange(req.query.wait_minutes, 'wait_minutes', 0, 600);
  const manual = req.query.distance_km === undefined || req.query.distance_km === ''
    ? null
    : numberInRange(req.query.distance_km, 'distance_km', 0.1, 600);

  let distance = null;
  let measured = null;
  if (req.query.from && req.query.to) {
    const from = text(req.query.from, 'from', { max: 80 });
    const to = text(req.query.to, 'to', { max: 80 });
    /* The client's own position decides which of the three towns called "Remera" is meant. */
    const near = req.query.near ? parseNear(req.query.near) : null;
    measured = await journeyDistance(from, to, near);
    if (!measured && !manual) {
      throw new ApiError(422, 'place_not_found', 'Those places were not found on the map. Enter the distance yourself.');
    }
    if (measured) distance = measured.distanceKm;
  }
  if (distance === null) {
    if (!manual) throw new ApiError(422, 'invalid_distance_km', 'Send from and to, or a distance_km');
    distance = manual;
  }

  const priced = fareFor(distance, vehicle, req.query.price_per_km, waitMinutes);
  res.json({
    distance_km: Math.round(distance * 100) / 100,
    source: measured ? measured.source : 'manual',
    from: measured ? measured.from : null,
    to: measured ? measured.to : null,
    fare_rwf: priced.fareRwf,
    components: priced.components,
    basis: priced.basis,
    wait_minutes: waitMinutes,
  });
});

export default router;
