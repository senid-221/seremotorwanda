import { Router } from 'express';
import { config } from '../config.js';
import { all, get, run } from '../db.js';
import { signToken, verifyToken, requireAuth, sessionPayload } from '../auth.js';
import { sendOtp, consumeOtp } from '../otp.js';
import { verifyGoogleCredential } from '../google.js';
import { fareHealth } from '../fares.js';
import { gateSignup, idConfigured, phoneCheckConfigured, rraConfigured } from '../kyc.js';
import { divisionHealth } from '../locations.js';
import {
  ApiError, KYC_RULES, normalizeRwandaPhone, normalizePlate, text, oneOf, idNumber, tinNumber, otpCode,
} from '../validate.js';

const router = Router();
const VEHICLE_TYPES = ['moto', 'car'];

const accountShape = (row) => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  plate: row.plate,
  vehicleType: row.vehicle_type,
  vehicle_type: row.vehicle_type,
  status: row.status,
  isAdmin: Boolean(row.is_admin),
  is_admin: Boolean(row.is_admin),
  idNumber: row.id_number,
  tinNumber: row.tin_number,
  reason: row.review_reason,
  zone: row.zone,
  zones: JSON.parse(row.zones),
  pricePerKm: row.price_per_km,
  services: row.services,
  capacity: row.capacity,
  availableSlots: JSON.parse(row.available_slots),
  online: Boolean(row.is_online),
  rating: row.rating_count ? Math.round((row.rating_sum / row.rating_count) * 10) / 10 : 0,
  trips: row.rating_count,
  createdAt: row.created_at,
  kyc: { tin: row.tin_status, id: row.id_status, phone: row.phone_status, at: row.kyc_at },
});

const conflictShape = (error) => {
  if (!error || error.code !== '23505') throw error;
  const constraint = String(error.constraint || '');
  const codes = {
    phone: ['phone_taken', 'That phone number already has an account. Log in instead.'],
    plate: ['plate_taken', 'That plate is already registered to another rider.'],
    id_number: ['id_number_taken', 'That national ID is already registered.'],
    tin_number: ['tin_number_taken', 'That TIN is already registered.'],
    google_id: ['google_taken', 'That Google account is already linked to another rider.'],
  };
  const found = Object.entries(codes).find(([field]) => constraint.includes(field))?.[1]
    || ['already_registered', 'That value is already registered.'];
  throw new ApiError(409, found[0], found[1]);
};

router.get('/api/config', (_req, res) => {
  res.json({
    googleClientId: config.google.clientId || null,
    liveLocationSeconds: config.liveLocationSeconds,
    fare: fareHealth(),
    /* The signup form validates against these numbers instead of carrying its own copy,
       and hides the live "check with RRA" buttons when no provider is wired up yet. */
    kyc: {
      ...KYC_RULES,
      rra: rraConfigured(),
      id: idConfigured() ? (config.idCheck.provider || 'generic') : null,
      phone: phoneCheckConfigured(),
    },
    /* The dropdowns only ask for divisions the server actually holds, so an unseeded build says so
       here rather than showing five empty selects. */
    divisions: divisionHealth(),
  });
});

router.post('/api/auth/otp/send', async (req, res) => {
  const phone = normalizeRwandaPhone(req.body.phone);
  res.json(await sendOtp(phone));
});

router.post('/api/auth/otp/verify', async (req, res) => {
  const phone = normalizeRwandaPhone(req.body.phone);
  const code = otpCode(req.body.code);
  await consumeOtp(phone, code);

  const row = await get('SELECT * FROM drivers WHERE phone = ?', phone);
  if (!row) {
    return res.json({ status: 'new', phone, verifyToken: signToken({ phoneVerified: phone }, 0.25) });
  }
  if (row.status === 'rejected') {
    return res.json({ status: 'rejected', reason: row.review_reason, message: 'This application was not approved.' });
  }
  if (!row.is_admin && config.adminPhone && config.adminPhone === phone) {
    await run('UPDATE drivers SET is_admin = 1 WHERE id = ?', row.id);
    row.is_admin = 1;
  }
  res.json({ status: row.status, token: signToken({ driverId: row.id }), driver: accountShape(row) });
});

router.post('/api/auth/signup', async (req, res) => {
  const names = text(req.body.names, 'names', { min: 3, max: 80 });
  const id = idNumber(req.body.id_number);
  const tin = tinNumber(req.body.tin_number);
  const plate = normalizePlate(req.body.plate);
  const phone = normalizeRwandaPhone(req.body.phone);
  const vehicleType = oneOf(req.body.vehicle_type, VEHICLE_TYPES, 'vehicle_type');

  const claims = verifyToken(req.body.verify_token);
  if (!claims) throw new ApiError(400, 'invalid_verify_token', 'Verify the phone number again before signing up.');
  if (claims.phoneVerified !== phone) {
    throw new ApiError(403, 'phone_not_verified', 'The code was verified for a different phone number.');
  }

  /* Nothing is filed until RRA, NIDA and the number check have had their say, so an
     application that cannot pass is rejected at the door instead of in the admin queue. */
  const kyc = await gateSignup({ phone, id, tin, names });

  let googleId = null;
  if (req.body.google_token) {
    const googleClaims = verifyToken(req.body.google_token);
    if (!googleClaims || !googleClaims.googleSubject) {
      throw new ApiError(400, 'invalid_google_token', 'That Google sign-in link expired. Sign in again.');
    }
    googleId = googleClaims.googleSubject;
  }

  let inserted;
  try {
    inserted = await run(
      `INSERT INTO drivers (phone, name, plate, vehicle_type, id_number, tin_number, google_id, status,
                            tin_status, id_status, phone_status, kyc_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now')) RETURNING id`,
      phone, names, plate, vehicleType, id, tin, googleId, kyc.tin, kyc.id, kyc.phone,
    );
  } catch (error) {
    conflictShape(error);
  }
  const row = await get('SELECT * FROM drivers WHERE id = ?', inserted.lastInsertRowid);
  res.status(201).json({
    status: 'submitted',
    message: 'Submitted. A SERE Moto admin has to approve your application before you can receive requests.',
    application: accountShape(row),
  });
});

router.post('/api/auth/google', async (req, res) => {
  const claims = await verifyGoogleCredential(req.body.credential);
  const row = await get('SELECT * FROM drivers WHERE google_id = ?', claims.subject);
  if (row) {
    if (row.status === 'rejected') {
      return res.json({ status: 'rejected', reason: row.review_reason });
    }
    return res.json({ status: row.status, token: signToken({ driverId: row.id }), driver: accountShape(row) });
  }
  res.json({
    status: 'new',
    name: claims.name,
    email: claims.emailVerified ? claims.email : null,
    googleToken: signToken({ googleSubject: claims.subject }, 0.25),
  });
});

router.get('/api/auth/me', requireAuth, async (req, res) => {
  const row = await get('SELECT * FROM drivers WHERE id = ?', req.driverId);
  if (!row) return res.status(401).json({ error: 'authentication_required' });
  res.json({ driver: accountShape(row) });
});

/* One browser holds one session, but it may belong to a rider or to a passenger.
   Every page asks this before it decides which dashboard to show, so a passenger's
   token is never mistaken for a driver's — and never thrown away by a driver-only call. */
router.get('/api/auth/session', async (req, res) => {
  const payload = sessionPayload(req);
  if (!payload) return res.json({ kind: null });

  if (payload.passengerId) {
    const row = await get('SELECT id, phone, name FROM passengers WHERE id = ?', payload.passengerId);
    if (!row) return res.json({ kind: null });
    return res.json({ kind: 'passenger', passenger: row });
  }
  if (payload.driverId) {
    const row = await get('SELECT id, name, phone, plate, status, is_admin AS "isAdmin" FROM drivers WHERE id = ?', payload.driverId);
    if (!row) return res.json({ kind: null });
    return res.json({ kind: 'driver', driver: { ...row, isAdmin: Boolean(row.isAdmin) } });
  }
  return res.json({ kind: null });
});

export default router;
