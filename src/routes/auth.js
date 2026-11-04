import { Router } from 'express';
import { config } from '../config.js';
import { all, get, run } from '../db.js';
import {
  assertLoginBudget, hashPassword, requireAuth, recordLoginFailure, sessionPayload, signToken,
  verifyPassword, verifyToken,
} from '../auth.js';
import { verifyGoogleCredential } from '../google.js';
import { fareHealth } from '../fares.js';
import { gateSignup, idConfigured, phoneCheckProvider, rraConfigured } from '../kyc.js';
import { divisionHealth } from '../locations.js';
import { DOCUMENT_TYPES_BY_KIND, documentHealth } from '../storage.js';
import {
  ApiError, KYC_RULES, PASSWORD_MIN, emailAddress, idNumber, normalizePlate, oneOf, password, text, tinNumber,
  normalizeRwandaPhone,
} from '../validate.js';

const router = Router();
const VEHICLE_TYPES = ['moto', 'car'];

const accountShape = (row) => ({
  id: row.id,
  email: row.email,
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
  /* A Google-only account has no password to type, so the login page has to say "use the Google
     button" instead of failing the same way a wrong password does. */
  hasPassword: Boolean(row.password_hash),
  kyc: { tin: row.tin_status, id: row.id_status, phone: row.phone_status, at: row.kyc_at },
});

const conflictShape = (error) => {
  if (!error || error.code !== '23505') throw error;
  const constraint = String(error.constraint || '');
  const codes = {
    email: ['email_taken', 'That email address already has an account. Log in instead.'],
    phone: ['phone_taken', 'That phone number already has an account.'],
    plate: ['plate_taken', 'That plate is already registered to another rider.'],
    id_number: ['id_number_taken', 'That national ID is already registered.'],
    tin_number: ['tin_number_taken', 'That TIN is already registered.'],
    google_id: ['google_taken', 'That Google account is already linked to another rider.'],
  };
  const found = Object.entries(codes).find(([field]) => constraint.includes(field))?.[1]
    || ['already_registered', 'That value is already registered.'];
  throw new ApiError(409, found[0], found[1]);
};

/* The session a signed-up or signed-in rider is handed. A draft is a real session — the rider needs
   it to file the details form and to upload their licence — but requireApproved keeps it out of the
   booking surfaces until an admin has said yes. */
async function grant(row) {
  if (!row.is_admin && config.adminEmail && config.adminEmail === row.email) {
    await run('UPDATE drivers SET is_admin = 1 WHERE id = ?', row.id);
    row.is_admin = 1;
  }
}

router.get('/api/config', (_req, res) => {
  res.json({
    googleClientId: config.google.clientId || null,
    liveLocationSeconds: config.liveLocationSeconds,
    fare: fareHealth(),
    /* The signup form validates against these numbers instead of carrying its own copy, and hides
       the live "check with RRA" buttons when no provider is wired up yet. The phone check is now a
       KYC field the details form screens, not the door a rider signs in through. */
    kyc: {
      ...KYC_RULES,
      passwordMin: PASSWORD_MIN,
      rra: rraConfigured(),
      id: idConfigured() ? (config.idCheck.provider || 'generic') : null,
      phone: phoneCheckProvider(),
    },
    /* The licence upload needs to know what the bucket will accept before it offers a file picker,
       and the details form needs to know whether the upload is even possible here. */
    documents: documentHealth(),
    documentTypes: DOCUMENT_TYPES_BY_KIND,
    /* The dropdowns only ask for divisions the server actually holds, so an unseeded build says so
       here rather than showing five empty selects. */
    divisions: divisionHealth(),
  });
});

/* --------------------------------------------------------------- email + password */

router.post('/api/auth/signup', async (req, res) => {
  const email = emailAddress(req.body.email);

  /* A rider who arrived through the Google button has already proved they hold that address, so the
     address Google vouched for wins and no password is needed for this account. */
  let googleId = null;
  if (req.body.google_token) {
    const claims = verifyToken(req.body.google_token);
    if (!claims || !claims.googleSubject) {
      throw new ApiError(400, 'invalid_google_token', 'That Google sign-in link expired. Tap Google again.');
    }
    googleId = claims.googleSubject;
    if (claims.googleEmail && claims.googleEmail !== email) {
      throw new ApiError(403, 'google_email_mismatch', 'That Google account belongs to a different email address.');
    }
  }

  const passphrase = req.body.password === undefined || req.body.password === null || req.body.password === ''
    ? null
    : password(req.body.password);
  if (!googleId && !passphrase) {
    throw new ApiError(422, 'invalid_password', `Password must be at least ${PASSWORD_MIN} characters`);
  }

  let inserted;
  try {
    inserted = await run(
      `INSERT INTO drivers (email, password_hash, google_id, status)
       VALUES (?, ?, ?, 'draft') RETURNING id`,
      email, passphrase ? hashPassword(passphrase) : null, googleId,
    );
  } catch (error) {
    conflictShape(error);
  }
  const row = await get('SELECT * FROM drivers WHERE id = ?', inserted.lastInsertRowid);
  await grant(row);
  res.status(201).json({
    status: 'draft',
    message: 'Account created. Now complete your details so an admin can review the application.',
    token: signToken({ driverId: row.id }),
    driver: accountShape(row),
  });
});

router.post('/api/auth/login', async (req, res) => {
  const email = emailAddress(req.body.email);
  assertLoginBudget(email, req.ip);
  const secret = String(req.body.password ?? '');

  const row = await get('SELECT * FROM drivers WHERE email = ?', email);

  /* A rider who arrived through the Google button never set a password, so typing one here cannot be
     a wrong guess — the answer is the button, not a failed login. */
  if (row && !row.password_hash) {
    throw new ApiError(403, 'google_account_only', 'This account was created with Google. Use the Google button.');
  }
  const claimed = row ? verifyPassword(secret, row.password_hash) : false;
  if (!row || !claimed) {
    /* One answer for "no such account" and "wrong password": a login form that distinguishes them is
       a list of who has an account here. Only a refusal spends the budget. */
    recordLoginFailure(email, req.ip);
    throw new ApiError(401, 'invalid_credentials', 'That email and password do not match an account.');
  }
  if (row.status === 'rejected') {
    return res.json({ status: 'rejected', reason: row.review_reason, message: 'This application was not approved.' });
  }
  await grant(row);
  res.json({ status: row.status, token: signToken({ driverId: row.id }), driver: accountShape(row) });
});

/* --------------------------------------------------------------- Google */

router.post('/api/auth/google', async (req, res) => {
  const claims = await verifyGoogleCredential(req.body.credential);
  let row = await get('SELECT * FROM drivers WHERE google_id = ?', claims.subject);
  /* The same person signing in with Google after they registered by email is one account, not two:
     only an address Google itself says is verified can tie them together. */
  if (!row && claims.emailVerified && claims.email) {
    row = await get('SELECT * FROM drivers WHERE email = ? AND google_id IS NULL', claims.email.toLowerCase());
    if (row) await run('UPDATE drivers SET google_id = ? WHERE id = ?', claims.subject, row.id);
  }
  if (row) {
    if (row.status === 'rejected') {
      return res.json({ status: 'rejected', reason: row.review_reason });
    }
    await grant(row);
    return res.json({ status: row.status, token: signToken({ driverId: row.id }), driver: accountShape(row) });
  }
  /* The address Google vouches for is stored lowercased, and signup compares it again after
     lowercasing what the rider typed — so the handshake value is normalised once, here. */
  const verifiedEmail = claims.emailVerified ? String(claims.email || '').toLowerCase() : null;
  res.json({
    status: 'new',
    name: claims.name,
    email: verifiedEmail,
    googleToken: signToken({ googleSubject: claims.subject, googleEmail: verifiedEmail }, 0.25),
  });
});

/* --------------------------------------------------------- complete your details */

/* The second half of signing up. Everything the old phone door used to prove is screened here
   instead: the number against the numbering plan, the TIN against RRA and the ID against NIDA, all
   inside gateSignup, so an application that cannot pass never reaches the admin queue. */
router.post('/api/auth/details', requireAuth, async (req, res) => {
  const row = await get('SELECT * FROM drivers WHERE id = ?', req.driverId);
  if (!row) throw new ApiError(401, 'authentication_required', 'Sign in again to continue');
  if (row.status !== 'draft') {
    throw new ApiError(409, 'details_already_filed', `This application was already ${row.status}.`);
  }

  const names = text(req.body.names, 'names', { min: 3, max: 80 });
  const id = idNumber(req.body.id_number);
  const tin = tinNumber(req.body.tin_number);
  const plate = normalizePlate(req.body.plate);
  const phone = normalizeRwandaPhone(req.body.phone);
  const vehicleType = oneOf(req.body.vehicle_type, VEHICLE_TYPES, 'vehicle_type');

  /* A trading licence is a document, not a number: it is uploaded to the bucket, and the application
     cannot be filed without it. When no bucket is configured the upload itself answers 503, so this
     is the same rule seen from the other side — the server never marks an application complete on a
     licence nobody was ever allowed to send. */
  if (documentHealth().configured) {
    const licence = await get(
      `SELECT status FROM driver_documents WHERE driver_id = ? AND kind = 'trading_licence'`,
      req.driverId,
    );
    if (!licence || licence.status !== 'uploaded') {
      throw new ApiError(422, 'licence_required', 'Upload your trading licence (PDF) before submitting.');
    }
  }

  const kyc = await gateSignup({ phone, id, tin, names });

  try {
    await run(
      `UPDATE drivers SET name = ?, phone = ?, plate = ?, vehicle_type = ?, id_number = ?, tin_number = ?,
              status = 'pending', tin_status = ?, id_status = ?, phone_status = ?, kyc_at = datetime('now'),
              review_reason = NULL
        WHERE id = ?`,
      names, phone, plate, vehicleType, id, tin, kyc.tin, kyc.id, kyc.phone, req.driverId,
    );
  } catch (error) {
    conflictShape(error);
  }
  const filed = await get('SELECT * FROM drivers WHERE id = ?', req.driverId);
  res.json({
    status: 'submitted',
    message: 'Submitted. A SERE Moto admin has to approve your application before you can receive requests.',
    application: accountShape(filed),
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
    const row = await get(
      `SELECT id, email, name, phone, plate, status, is_admin AS "isAdmin" FROM drivers WHERE id = ?`,
      payload.driverId,
    );
    if (!row) return res.json({ kind: null });
    return res.json({ kind: 'driver', driver: { ...row, isAdmin: Boolean(row.isAdmin) } });
  }
  return res.json({ kind: null });
});

export default router;
