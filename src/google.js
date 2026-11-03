import crypto from 'node:crypto';
import { config } from './config.js';
import { ApiError } from './validate.js';

const CACHE_MS = 10 * 60 * 1000;
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
let cache = { keys: [], fetchedAt: 0 };

const decodePart = (part) => {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new ApiError(401, 'google_token_invalid', 'Google did not send a readable sign-in token.');
  }
};

const invalid = (code, message) => new ApiError(401, code, message);

async function signingKeys() {
  if (cache.keys.length && Date.now() - cache.fetchedAt < CACHE_MS) return cache.keys;
  const response = await fetch(config.google.certsUrl, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new ApiError(502, 'google_lookup_failed', `Google's key service replied with HTTP ${response.status}.`);
  }
  const body = await response.json();
  cache = { keys: Array.isArray(body.keys) ? body.keys : [], fetchedAt: Date.now() };
  return cache.keys;
}

export async function verifyGoogleCredential(credential) {
  if (!config.google.clientId) {
    throw new ApiError(503, 'google_not_configured', 'Google sign-in is not enabled on this server yet.');
  }
  const parts = String(credential || '').split('.');
  if (parts.length !== 3) throw invalid('google_token_invalid', 'Google did not send a readable sign-in token.');

  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  const now = Math.floor(Date.now() / 1000);

  if (header.alg !== 'RS256' || !header.kid) throw invalid('google_token_invalid', 'Unexpected Google token format.');
  if (!claims.sub) throw invalid('google_token_invalid', 'Google token has no account id.');
  if (!claims.exp || claims.exp < now) throw invalid('google_token_expired', 'The Google sign-in token expired. Try again.');
  if (claims.aud !== config.google.clientId) throw invalid('google_audience_mismatch', 'That Google token was not issued for this site.');
  if (!ISSUERS.includes(claims.iss)) throw invalid('google_issuer_mismatch', 'That Google token did not come from Google.');

  let jwk = (await signingKeys()).find((key) => key.kid === header.kid);
  if (!jwk) {
    cache = { keys: [], fetchedAt: 0 };
    jwk = (await signingKeys()).find((key) => key.kid === header.kid);
  }
  if (!jwk) throw invalid('google_key_unknown', 'Google signing key is no longer available. Try again.');

  const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  const signature = Buffer.from(parts[2], 'base64url');
  const verified = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'), key, signature);
  if (!verified) throw invalid('google_signature_invalid', 'The Google sign-in token signature did not verify.');

  return {
    subject: String(claims.sub),
    email: claims.email ? String(claims.email) : null,
    emailVerified: Boolean(claims.email_verified),
    name: claims.name ? String(claims.name).slice(0, 80) : null,
  };
}
