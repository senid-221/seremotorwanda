import crypto from 'node:crypto';
import { config } from './config.js';
import { get } from './db.js';
import { ApiError } from './validate.js';

const secret = () => {
  if (config.jwtSecret.length < 32) {
    throw Object.assign(new Error('JWT_SECRET must be set to at least 32 characters'), { status: 500 });
  }
  return config.jwtSecret;
};

export const hashCode = (value) => crypto.createHmac('sha256', secret()).update(String(value)).digest('hex');
export const matchesHash = (value, stored) => {
  const actual = Buffer.from(hashCode(value), 'hex');
  const expected = Buffer.from(String(stored || ''), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function signToken(payload, hours = config.sessionHours) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + Math.round(hours * 3600) };
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(body)}`;
  const signature = crypto.createHmac('sha256', secret()).update(data).digest('base64url');
  return `${data}.${signature}`;
}

export function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', secret()).update(data).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

const bearer = (req) => {
  const header = req.get('authorization') || '';
  return verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
};

/* Whoever this request's token belongs to, without deciding which area may ask. */
export function sessionPayload(req) {
  return bearer(req) || null;
}

export function requireAuth(req, res, next) {
  const payload = bearer(req);
  if (!payload) {
    res.status(401).json({ error: 'authentication_required', message: 'Sign in again to continue' });
    return undefined;
  }
  if (!payload.driverId) {
    res.status(401).json({ error: 'authentication_required' });
    return undefined;
  }
  req.driverId = payload.driverId;
  return next();
}

/* Passenger sessions hold a passengerId instead of a driverId, so the two can never be confused. */
export async function requirePassenger(req, res, next) {
  const payload = bearer(req);
  if (!payload) {
    res.status(401).json({ error: 'passenger_authentication_required', message: 'Sign in with your phone number first' });
    return undefined;
  }
  if (!payload.passengerId) {
    res.status(401).json({ error: 'passenger_authentication_required', message: 'Sign in with your phone number first' });
    return undefined;
  }
  const row = await get('SELECT id, phone, name FROM passengers WHERE id = ?', payload.passengerId);
  if (!row) {
    res.status(401).json({ error: 'passenger_authentication_required', message: 'Sign in with your phone number again' });
    return undefined;
  }
  req.passenger = row;
  return next();
}

/* Booking works with or without a session; when the token is a passenger's, the trip is linked to them. */
export async function passengerIfSignedIn(req) {
  const payload = bearer(req);
  if (!payload || !payload.passengerId) return null;
  return (await get('SELECT id, phone, name FROM passengers WHERE id = ?', payload.passengerId)) || null;
}

export async function requireApproved(req, res, next) {
  const row = await get('SELECT status FROM drivers WHERE id = ?', req.driverId);
  if (!row) return res.status(401).json({ error: 'authentication_required' });
  if (row.status !== 'approved') {
    return res.status(403).json({
      error: 'account_pending',
      message: 'A SERE Moto admin has not approved this account yet',
    });
  }
  return next();
}

export async function requireAdmin(req, res, next) {
  const row = await get('SELECT status, is_admin FROM drivers WHERE id = ?', req.driverId);
  if (!row) return res.status(401).json({ error: 'authentication_required' });
  if (!row.is_admin) return res.status(403).json({ error: 'admin_only', message: 'Admin access only' });
  return next();
}
