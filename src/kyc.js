/* SERE Moto — identity and taxpayer lookups against the services that actually know:
   RRA for the 9-digit TIN, NIDA (or peleza.com, or any contract handed to us) for the
   national ID, and numverify (or an HLR-style service) for the phone number.

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

/* Scripted callers cannot be allowed to drive RRA or NIDA: every lookup is bound to the account
   that asked for it — a phone number for a passenger, a driver id for a rider — and each one gets a
   fixed hourly budget. */
const attempts = new Map();

function assertQuota(key, max = 12) {
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((at) => now - at < 3600_000);
  if (recent.length >= max) {
    throw new ApiError(429, 'kyc_rate_limited', 'Too many verification attempts for this applicant. Try again later.');
  }
  recent.push(now);
  attempts.set(key, recent);
}

/* -------------------------------------- RRA / TIN ------------------------------------ */

export const rraConfigured = () => Boolean(
  config.rra.baseUrl && (config.rra.apiKey || (config.rra.username && config.rra.password)),
);

export async function verifyTin(tin, { key = null, force = false } = {}) {
  if (!force) {
    const hit = await readCache('tin', tin);
    if (hit) return { valid: Boolean(hit.valid), taxpayer: hit.taxpayer, source: 'cache', checkedAt: hit.checked_at };
  }
  if (!rraConfigured()) {
    throw new ApiError(503, 'tin_check_unavailable', 'TIN verification is not connected to RRA yet');
  }
  if (key) assertQuota(key);

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

export async function verifyId(number, names, { key = null, force = false } = {}) {
  if (!force) {
    const hit = await readCache('id', number);
    if (hit) return { match: Boolean(hit.match), exists: Boolean(hit.match), name: hit.name, source: 'cache', checkedAt: hit.checked_at };
  }
  if (!idConfigured()) {
    throw new ApiError(503, 'id_check_unavailable', 'National ID verification is not connected to NIDA yet');
  }
  if (key) assertQuota(key);

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

/* Two contracts are understood here. numverify (one access key, one GET) answers whether the
   digits form a real number in the international numbering plan; a handed-over HLR endpoint
   behind PHONE_CHECK_* answers whether the line is live. numverify is the first choice because it
   is the self-serve one, and sign-in now rests on it entirely. */

export const numverifyConfigured = () => Boolean(config.numverify.key);
export const phoneCheckConfigured = () => numverifyConfigured()
  || Boolean(config.phoneCheck.url && config.phoneCheck.key);
export const phoneCheckProvider = () => (numverifyConfigured() ? 'numverify'
  : (config.phoneCheck.url && config.phoneCheck.key ? 'generic' : null));

const invalidPhone = (source) => new ApiError(
  422,
  source === 'numverify' ? 'phone_invalid' : 'phone_not_live',
  source === 'numverify'
    ? 'That is not a valid Rwandan mobile number. Check the digits and try again.'
    : 'That number is not active on any Rwandan network.',
);

/* numverify answers with {"success":false,"errors":{...}} or {"error":{...}} when the key is
   wrong or the quota is spent, and the api.apilayer.com gateway answers a bare {"message":…}
   instead — an outage on our side either way, never a verdict about the passenger. */
function numverifyFault(body) {
  if (!body || typeof body !== 'object') return null;
  const errors = body.errors || body.error || null;
  if (body.success === false || errors || body.message) {
    const info = errors && typeof errors === 'object'
      ? (errors.info || errors.message || errors.type || JSON.stringify(errors))
      : String(errors || body.message || 'rejected');
    return `numverify refused the request: ${String(info).slice(0, 160)}`;
  }
  return null;
}

async function queryNumverify(phone) {
  const url = new URL(`${config.numverify.baseUrl}/validate`);
  url.searchParams.set('access_key', config.numverify.key);
  url.searchParams.set('number', `+250${phone.slice(1)}`);
  let response;
  try {
    /* The two hosts that serve a numverify key read it differently — apilayer.net wants the
       access_key parameter, the api.apilayer.com gateway wants the apikey header — so the key
       goes both ways and NUMVERIFY_BASE_URL alone decides which host answers. */
    response = await request(url, {
      method: 'GET',
      headers: { apikey: config.numverify.key },
      timeoutMs: config.numverify.timeoutMs,
    });
  } catch (error) {
    throw new ApiError(502, 'phone_check_unavailable', `numverify did not answer: ${error.message}`);
  }
  const body = await response.json().catch(() => null);
  const fault = numverifyFault(body);
  if (fault) throw new ApiError(response.ok ? 502 : 502, 'phone_check_unavailable', fault);
  if (!response.ok) {
    throw new ApiError(502, 'phone_check_unavailable', `numverify replied with HTTP ${response.status}`);
  }
  const valid = pickFlag(body, '', ['valid', 'isvalid', 'validphone', 'numbervalid']);
  if (valid === null) {
    throw new ApiError(502, 'phone_check_unavailable', `The numverify answer could not be read (${describe(body)})`);
  }
  const carrier = pickText(body, '', ['carrier', 'network', 'operator', 'provider']);
  const lineType = pickText(body, '', ['line_type', 'linetype', 'type']);
  const detail = [carrier, lineType].filter(Boolean).join(' / ') || null;
  await writeCache('phone', phone, valid, detail, 'numverify', valid ? null : describe(body));
  return { valid, operator: detail, source: 'numverify' };
}

export async function checkPhone(phone, { force = false } = {}) {
  if (!force) {
    const hit = await readCache('phone', phone);
    if (hit) return { valid: Boolean(hit.valid), operator: hit.operator, source: 'cache' };
  }
  if (numverifyConfigured()) return queryNumverify(phone);
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

/* A passenger's whole identity is a phone number, so for them this lookup is the only thing standing
   between a stranger and a session: an unreadable answer or a number that is not in the plan refuses
   the sign-in instead of waving it through. A cached REJECTION is re-checked live, because the plan
   data is wrong often enough that a stale "no" should not lock a real subscriber out for half an
   hour. A rider no longer signs in this way — for a rider the same check is one field of the KYC
   form, and gateSignup below is where it runs. */
export async function requireRealPhone(phone) {
  if (!phoneCheckConfigured()) {
    throw new ApiError(503, 'phone_check_unavailable',
      'No phone verification service is configured (NUMVERIFY_ACCESS_KEY), so no number can be verified.');
  }
  let result = await checkPhone(phone);
  if (!result.valid) result = await checkPhone(phone, { force: true });
  if (!result.valid) throw invalidPhone(result.source);
  return result;
}

/* A number now mints its own session, so the door gets a budget: 30 verifications per phone and 300
   per network an hour. Comfortable for a rider tapping twice, useless to a script walking +250. */
const VERIFY_PHONE_PER_HOUR = 30;
const VERIFY_IP_PER_HOUR = 300;
const verifyLog = { phone: new Map(), ip: new Map() };

function spendBudget(map, key, max) {
  const now = Date.now();
  const recent = (map.get(key) || []).filter((at) => now - at < 3_600_000);
  if (recent.length >= max) {
    throw new ApiError(429, 'verify_rate_limited', 'Too many verifications in the last hour. Try again later.');
  }
  recent.push(now);
  map.set(key, recent);
}

export function assertVerifyBudget(phone, ip) {
  spendBudget(verifyLog.phone, phone, VERIFY_PHONE_PER_HOUR);
  if (ip) spendBudget(verifyLog.ip, ip, VERIFY_IP_PER_HOUR);
}

export async function gateSignup({ phone, id, tin, names }) {
  const verdict = { tin: 'unchecked', id: 'unchecked', phone: 'unchecked' };

  if (rraConfigured()) {
    verdict.tin = await verdictOf(async () => {
      const result = await verifyTin(tin, { key: phone });
      if (!result.valid) throw new ApiError(422, 'tin_not_found', 'No RRA taxpayer holds that TIN.');
    });
  }

  if (idConfigured()) {
    verdict.id = await verdictOf(async () => {
      const result = await verifyId(id, names, { key: phone });
      if (!result.exists) throw new ApiError(422, 'id_not_found', 'That national ID number is not in the civil register.');
      if (!result.match) throw new ApiError(422, 'id_name_mismatch', 'The names held for that ID do not match the names you entered.');
    });
  }

  if (phoneCheckConfigured()) {
    verdict.phone = await verdictOf(async () => {
      const result = await checkPhone(phone);
      if (!result.valid) throw invalidPhone(result.source);
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
  phone: phoneCheckProvider() || false,
  strict: config.kycStrict,
});
