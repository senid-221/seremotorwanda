/* SERE Moto — identity and taxpayer lookups against the services that actually know:
   RRA for the 9-digit TIN, NIDA (or peleza.com, or any contract handed to us) for the
   national ID, and an HLR-style service for the phone number.

   The frontend never talks to these providers. It calls /api/verify-tin and /api/verify-id
   on this server, which holds the credentials, caches the verdict and answers in one shape.
   Contracts differ per provider, so the field carrying the verdict is either pinned in env
   (RRA_VALID_FIELD, RRA_NAME_FIELD, ID_MATCH_FIELD, ID_NAME_FIELD) or read from the names
   these APIs are known to use. A response that cannot be understood is reported as
   unavailable together with the keys it actually contained — never as a pass, because a
   green tick on a number nobody checked is worse than no tick at all. */
import { config } from './config.js';
import { get, run } from './db.js';
import { ApiError } from './validate.js';

const PASS_WINDOW = "datetime('now', '-24 hours')";
const FAIL_WINDOW = "datetime('now', '-30 minutes')";

const TRUTHY = ['true', 'yes', 'ok', 'valid', 'active', 'success', 'sent', 'found', 'verified',
  'match', 'matched', 'registered', 'pass', 'passed', 'routable', '1'];
const FALSY = ['false', 'no', 'invalid', 'inactive', 'failed', 'fail', 'notfound', 'unverified',
  'mismatch', 'deactivated', 'blocked', 'cancelled', '0'];

/* "0" means success in some government API dialects and failure in others, so a bare number is
   only trusted when the contract pins which field carries the verdict (RRA_VALID_FIELD,
   ID_MATCH_FIELD). Auto-detected keys must be a boolean or a word. */
const toFlag = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  const text = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!text) return null;
  if (TRUTHY.includes(text)) return true;
  if (FALSY.includes(text)) return false;
  return null;
};

const norm = (key) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

function walk(value, visit, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  for (const [key, inner] of Object.entries(value)) {
    if (visit(key, inner) === true) return inner;
    if (inner && typeof inner === 'object') {
      const deeper = walk(inner, visit, depth + 1);
      if (deeper !== null && deeper !== undefined) return deeper;
    }
  }
  return null;
}

/* The first value anywhere in the tree whose key is one of `names`. */
function findValue(body, names, accept) {
  if (!body || typeof body !== 'object' || !names) return null;
  const wanted = names.map(norm);
  const found = walk(body, (key, value) => accept(value) && wanted.includes(norm(key)));
  return found === undefined ? null : found;
}

function pickFlag(body, pinnedField, names) {
  const pinned = findValue(body, [pinnedField], (value) => value !== null && typeof value !== 'object');
  if (pinned !== null) return toFlag(pinned);
  const word = findValue(body, names, (value) => typeof value === 'boolean'
    || (typeof value === 'string' && value.trim() !== ''));
  return word === null ? null : toFlag(word);
}

/* A pinned field name wins; otherwise the first string under any known name. */
function pickText(body, pinnedField, names) {
  const pinned = findValue(body, [pinnedField], (value) => typeof value === 'string' && value.trim() !== '');
  if (pinned !== null) return String(pinned).trim();
  const found = findValue(body, names, (value) => typeof value === 'string' && value.trim() !== '');
  return found === null ? null : String(found).trim();
}

const describe = (body) => {
  if (!body || typeof body !== 'object') return 'a body that is not an object';
  const keys = Object.keys(body).slice(0, 12);
  return keys.length ? `keys: ${keys.join(', ')}` : 'an empty object';
};

async function request(url, { method = 'POST', headers = {}, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const authHeaders = ({ key, username, password }) => {
  if (key) return { Authorization: `Bearer ${key}` };
  if (username && password) return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  return {};
};

/* ----------------------------------- verdict cache ---------------------------------- */

const CACHE = {
  tin: { table: 'tin_checks', column: 'tin', verdict: 'valid', detail: 'taxpayer' },
  id: { table: 'id_checks', column: 'id_number', verdict: 'match', detail: 'name' },
  phone: { table: 'phone_checks', column: 'phone', verdict: 'valid', detail: 'operator' },
};

async function readCache(kind, key) {
  const spec = CACHE[kind];
  const fresh = await get(`SELECT * FROM ${spec.table} WHERE ${spec.column} = ?`, key);
  if (!fresh) return null;
  const window = fresh[spec.verdict] ? PASS_WINDOW : FAIL_WINDOW;
  const alive = (await get(`SELECT (? > ${window}) AS fresh`, fresh.checked_at)).fresh;
  return alive ? fresh : null;
}

async function writeCache(kind, key, verdict, detail, source, note) {
  const spec = CACHE[kind];
  await run(
    `INSERT INTO ${spec.table} (${spec.column}, ${spec.verdict}, ${spec.detail}, source, note, checked_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(${spec.column}) DO UPDATE SET
       ${spec.verdict} = excluded.${spec.verdict}, ${spec.detail} = excluded.${spec.detail},
       source = excluded.source, note = excluded.note, checked_at = excluded.checked_at`,
    key, verdict ? 1 : 0, detail || null, source, note || null,
  );
}

/* Anonymous callers cannot be allowed to drive RRA or NIDA: the verify_token binds every
   lookup to a phone that just proved it owns itself, and each phone gets a fixed budget. */
const attempts = new Map();

function assertQuota(phone, max = 12) {
  const now = Date.now();
  const recent = (attempts.get(phone) || []).filter((at) => now - at < 3600_000);
  if (recent.length >= max) {
    throw new ApiError(429, 'kyc_rate_limited', 'Too many verification attempts for this phone. Try again later.');
  }
  recent.push(now);
  attempts.set(phone, recent);
}

/* -------------------------------------- RRA / TIN ------------------------------------ */

export const rraConfigured = () => Boolean(
  config.rra.baseUrl && (config.rra.apiKey || (config.rra.username && config.rra.password)),
);

export async function verifyTin(tin, { phone = null, force = false } = {}) {
  if (!force) {
    const hit = await readCache('tin', tin);
    if (hit) return { valid: Boolean(hit.valid), taxpayer: hit.taxpayer, source: 'cache', checkedAt: hit.checked_at };
  }
  if (!rraConfigured()) {
    throw new ApiError(503, 'tin_check_unavailable', 'TIN verification is not connected to RRA yet');
  }
  if (phone) assertQuota(phone);

  const headers = authHeaders(config.rra);
  const endpoint = `${config.rra.baseUrl}${config.rra.path}`;
  const url = config.rra.style === 'json' ? endpoint : `${endpoint}?${encodeURIComponent(config.rra.field)}=${encodeURIComponent(tin)}`;
  let response;
  try {
    response = await request(url, {
      method: config.rra.style === 'json' ? 'POST' : 'GET',
      headers,
      body: config.rra.style === 'json' ? { [config.rra.field]: tin } : undefined,
      timeoutMs: config.rra.timeoutMs,
    });
  } catch (error) {
    throw new ApiError(502, 'tin_check_unavailable', `RRA did not answer: ${error.message}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(502, 'tin_check_unavailable', `RRA replied with HTTP ${response.status}`);
  }

  const flag = pickFlag(body, config.rra.validField, ['valid', 'isvalid', 'validtin', 'exists', 'found',
    'customerfound', 'success', 'issuccess', 'status', 'result']);
  const taxpayer = pickText(body, config.rra.nameField, ['customername', 'taxpayername', 'tradename',
    'legalname', 'tinname', 'name', 'customer']);

  if (flag === null && !taxpayer) {
    throw new ApiError(502, 'tin_check_unavailable',
      `RRA answered in a shape this server cannot read (${describe(body)}). Pin RRA_VALID_FIELD or RRA_NAME_FIELD.`);
  }
  const valid = flag === true || (flag === null && Boolean(taxpayer));
  await writeCache('tin', tin, valid, taxpayer, 'rra', valid ? null : describe(body));
  return { valid, taxpayer, source: 'rra' };
}

/* --------------------------------- NIDA / peleza / ID --------------------------------- */

export const idConfigured = () => Boolean(
  config.idCheck.url && (config.idCheck.key || (config.idCheck.username && config.idCheck.password)),
);

/* Both directions of token inclusion, so "Habimana Jean" matches "JEAN HABIMANA" and an
   applicant who entered three names still matches a register holding two of them. */
export function namesMatch(entered, held) {
  const tokens = (value) => String(value || '').toLowerCase().split(/[^a-zàâçéèêëîïôûùüÿñæœ]+/).filter((t) => t.length > 1);
  const left = tokens(entered);
  const right = tokens(held);
  if (!left.length || !right.length) return false;
  const holds = (outer, inner) => inner.every((token) => outer.includes(token));
  return holds(left, right) || holds(right, left);
}

export async function verifyId(number, names, { phone = null, force = false } = {}) {
  if (!force) {
    const hit = await readCache('id', number);
    if (hit) return { match: Boolean(hit.match), exists: Boolean(hit.match), name: hit.name, source: 'cache', checkedAt: hit.checked_at };
  }
  if (!idConfigured()) {
    throw new ApiError(503, 'id_check_unavailable', 'National ID verification is not connected to NIDA yet');
  }
  if (phone) assertQuota(phone);

  const parts = String(names || '').trim().split(/\s+/);
  let response;
  try {
    response = await request(config.idCheck.url, {
      method: 'POST',
      headers: authHeaders(config.idCheck),
      body: {
        idNumber: number,
        id_number: number,
        firstName: parts[0] || '',
        lastName: parts.slice(1).join(' '),
        fullName: names,
      },
      timeoutMs: config.idCheck.timeoutMs,
    });
  } catch (error) {
    throw new ApiError(502, 'id_check_unavailable', `The ID service did not answer: ${error.message}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(502, 'id_check_unavailable', `The ID service replied with HTTP ${response.status}`);
  }

  const flag = pickFlag(body, config.idCheck.matchField, ['match', 'matches', 'ismatch', 'ismatched',
    'verified', 'isverified', 'exists', 'found', 'valid', 'status', 'result']);
  const held = pickText(body, config.idCheck.nameField, ['firstname', 'lastname', 'fullname', 'name',
    'holdername', 'nationalidname', 'legalname', 'customername']);

  if (flag === null && !held) {
    throw new ApiError(502, 'id_check_unavailable',
      `The ID service answered in a shape this server cannot read (${describe(body)}). Pin ID_MATCH_FIELD or ID_NAME_FIELD.`);
  }
  const exists = flag === true || (flag === null && Boolean(held));
  const match = exists && (!held || !names || namesMatch(names, held));
  await writeCache('id', number, match, held, config.idCheck.provider || 'generic', exists ? null : describe(body));
  return { match, exists, name: held, source: config.idCheck.provider || 'generic' };
}

/* ---------------------------------- phone number check --------------------------------- */

export const phoneCheckConfigured = () => Boolean(config.phoneCheck.url && config.phoneCheck.key);

export async function checkPhone(phone, { force = false } = {}) {
  if (!force) {
    const hit = await readCache('phone', phone);
    if (hit) return { valid: Boolean(hit.valid), operator: hit.operator, source: 'cache' };
  }
  if (!phoneCheckConfigured()) {
    throw new ApiError(503, 'phone_check_unavailable', 'Phone number verification is not configured');
  }
  const international = `+250${phone.slice(1)}`;
  let response;
  try {
    response = await request(config.phoneCheck.url, {
      headers: authHeaders({ key: config.phoneCheck.key }),
      body: { phoneNumber: international, msisdn: international, phone: international },
      timeoutMs: config.phoneCheck.timeoutMs,
    });
  } catch (error) {
    throw new ApiError(502, 'phone_check_unavailable', `The phone check service did not answer: ${error.message}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(502, 'phone_check_unavailable', `The phone check service replied with HTTP ${response.status}`);
  }
  const valid = pickFlag(body, '', ['valid', 'isvalid', 'validphone', 'active', 'numberactive',
    'live', 'routable', 'status', 'result', 'success']);
  if (valid === null) {
    throw new ApiError(502, 'phone_check_unavailable', `The phone check answer could not be read (${describe(body)})`);
  }
  const operator = pickText(body, '', ['operator', 'network', 'carrier', 'provider']);
  await writeCache('phone', phone, valid, operator, 'hlr', valid ? null : describe(body));
  return { valid, operator, source: 'hlr' };
}

/* ---------------------------------- signup verdict ----------------------------------- */

/* Every service that is wired up has to answer for itself. One that is not configured records
   "unchecked" — visible in the admin queue, so an absent provider is never read as a pass.
   A service that IS configured but does not answer records "unavailable", because an RRA
   outage must not stop every new rider in Kigali from signing up — unless KYC_STRICT=1, which
   says no application is accepted without a verdict from all three. A number that comes back
   wrong is a hard rejection in both modes: it is not an outage, it is a bad application. */
const UNAVAILABLE = ['tin_check_unavailable', 'id_check_unavailable', 'phone_check_unavailable'];

const verdictOf = async (check) => {
  try {
    await check();
    return 'pass';
  } catch (error) {
    if (!UNAVAILABLE.includes(error.code)) throw error;
    if (config.kycStrict) throw error;
    return 'unavailable';
  }
};

export async function gateSignup({ phone, id, tin, names }) {
  const verdict = { tin: 'unchecked', id: 'unchecked', phone: 'unchecked' };

  if (rraConfigured()) {
    verdict.tin = await verdictOf(async () => {
      const result = await verifyTin(tin, { phone });
      if (!result.valid) throw new ApiError(422, 'tin_not_found', 'No RRA taxpayer holds that TIN.');
    });
  }

  if (idConfigured()) {
    verdict.id = await verdictOf(async () => {
      const result = await verifyId(id, names, { phone });
      if (!result.exists) throw new ApiError(422, 'id_not_found', 'That national ID number is not in the civil register.');
      if (!result.match) throw new ApiError(422, 'id_name_mismatch', 'The names held for that ID do not match the names you entered.');
    });
  }

  if (phoneCheckConfigured()) {
    verdict.phone = await verdictOf(async () => {
      const result = await checkPhone(phone);
      if (!result.valid) throw new ApiError(422, 'phone_not_live', 'That number is not active on any Rwandan network.');
    });
  }

  if (config.kycStrict) {
    const missing = Object.entries(verdict).filter(([, state]) => state === 'unchecked').map(([name]) => name);
    if (missing.length) {
      throw new ApiError(503, 'kyc_unreachable', `KYC_STRICT is on but these checks are not configured: ${missing.join(', ')}.`);
    }
  }
  return verdict;
}

export const kycSummary = () => ({
  rra: rraConfigured(),
  id: idConfigured() ? (config.idCheck.provider || 'generic') : false,
  phone: phoneCheckConfigured(),
  strict: config.kycStrict,
});
