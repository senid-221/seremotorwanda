import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';
import { runSeed, startPostgres, scratchEnv } from './pg-harness.js';

/* The suite seeds and boots its own server against a throwaway database, so `npm test` cannot leave test
   accounts in live data. Set BASE_URL only when you deliberately want to run these checks against a server
   that is already running — that will create riders, trips and payments on that database. */
const ROOT = path.join(import.meta.dirname, '..');
const EXTERNAL = process.env.BASE_URL;
const PORT = Number(process.env.TEST_PORT || crypto.randomInt(4900, 5900));
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;

/* Read the same .env the server boots from, so `npm test` and the server can never disagree. */
const PAYSTACK_KEY = config.paystack.secretKey;
const ADMIN_PHONE = config.adminPhone || `078${crypto.randomInt(10000, 99999)}90`;

let passed = 0;
const failures = [];
const skipped = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    if (error.message === '__SKIP__') {
      skipped.push(name);
      console.log(`  skip ${name}`);
      return;
    }
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

async function api(pathname, { method = 'GET', body, token, raw } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(raw !== undefined || body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

const tag = crypto.randomInt(10000, 99999).toString();
const phoneFor = (n) => `078${tag}${String(n).padStart(2, '0')}`;
const plateFor = (letter) => `RT${letter} ${tag.slice(0, 4)} ${letter}`;
const idFor = (n) => `1198500${tag}${String(n).padStart(4, '0')}`;
const tinFor = (n) => `10${tag}${String(n).padStart(2, '0')}`;

// With no SMS provider configured and OTP_ECHO=1 the server echoes the code back, which is what lets this
// suite run. On a deployment without OTP_ECHO the OTP checks below fail with the message in verifyOtp().
// If the server enforces a resend cooldown the helper waits it out instead of failing.
async function sendOtp(phone) {
  const first = await api('/api/auth/otp/send', { method: 'POST', body: { phone } });
  if (first.status === 429 && first.json.error === 'otp_rate_limited') {
    const wait = Number(String(first.json.message).match(/Wait (\d+)s/)?.[1] || 30) + 1;
    await sleep(wait * 1000);
    const retry = await api('/api/auth/otp/send', { method: 'POST', body: { phone } });
    assert.equal(retry.status, 200, `otp/send still returned ${retry.status} ${JSON.stringify(retry.json)}`);
    return retry.json;
  }
  assert.equal(first.status, 200, `otp/send returned ${first.status} ${JSON.stringify(first.json)}`);
  return first.json;
}

async function verifyOtp(phone) {
  const sent = await sendOtp(phone);
  assert.ok(sent.devCode, 'no devCode in the response — the server needs SMS_PROVIDER_URL/KEY empty and OTP_ECHO=1 for this suite');
  const verified = await api('/api/auth/otp/verify', { method: 'POST', body: { phone, code: sent.devCode } });
  assert.equal(verified.status, 200, `otp/verify returned ${verified.status} ${JSON.stringify(verified.json)}`);
  return verified.json;
}

// Returns the short-lived token that proves a brand-new phone number was verified.
async function signupTokenFor(phone) {
  const json = await verifyOtp(phone);
  assert.equal(json.status, 'new', `expected a brand-new phone, got ${JSON.stringify(json)}`);
  assert.ok(json.verifyToken?.length > 20, 'expected a signup token');
  return json.verifyToken;
}

async function signupNew(body) {
  return api('/api/auth/signup', { method: 'POST', body: { ...body, verify_token: await signupTokenFor(body.phone) } });
}

let driverToken = '';
let driverId = 0;
let secondToken = '';
let secondId = 0;
let adminToken = '';
let requestId = 0;

let scratchChild = null;
let scratchWatchdog = null;
let scratchExitCode = null;
let scratchLog = '';
let scratchPg = null;

async function startScratchServer() {
  scratchPg = await startPostgres();
  const env = scratchEnv(scratchPg, {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    ADMIN_PHONE,
    OTP_ECHO: '1',
  });
  await runSeed(env);

  scratchChild = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  scratchChild.stdout.on('data', (chunk) => { scratchLog += chunk; });
  scratchChild.stderr.on('data', (chunk) => { scratchLog += chunk; });
  scratchChild.on('exit', (code) => { scratchExitCode = code; });

  /* A stuck request must never leave the suite running forever against a half-dead scratch server. */
  scratchWatchdog = setTimeout(() => {
    console.error(`\n[seremoto] smoke suite timed out. Scratch server log:\n${scratchLog}`);
    scratchChild?.kill();
    process.exit(1);
  }, 180000);
  process.on('exit', () => { clearTimeout(scratchWatchdog); scratchChild?.kill(); });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (scratchExitCode !== null) throw new Error(`the scratch server exited (${scratchExitCode}) before it answered /api/health:\n${scratchLog}`);
    const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })
      .then((response) => response.json()).catch(() => null);
    if (health?.ok) return;
    await sleep(250);
  }
  throw new Error(`the scratch server never came up:\n${scratchLog}`);
}

if (EXTERNAL) {
  console.log(`SERE Moto API smoke suite against the running server at ${BASE}\n`);
  console.log('[seremoto] WARNING: BASE_URL is set, so these checks will write rows into that database.\n');
} else {
  await startScratchServer();
  console.log(`SERE Moto API smoke suite on a scratch Postgres instance (${scratchPg.label})\n`);
}

await check('health reports the fifteen tables', async () => {
  const { status, json } = await api('/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.tables, 15);
  assert.ok(json.kyc, 'health must say which credential checks are wired up');
  assert.equal(typeof json.kyc.rra, 'boolean');
});

await check('config publishes the same digit laws the API enforces', async () => {
  const { json } = await api('/api/config');
  assert.equal(json.kyc.phoneDigits, 10);
  assert.equal(json.kyc.idDigits, 16);
  assert.equal(json.kyc.tinDigits, 9);
});

await check('config publishes the regulated fare table', async () => {
  const { status, json } = await api('/api/config');
  assert.equal(status, 200);
  assert.match(json.fare.basis, /RURA/);
  assert.equal(json.fare.motorcycle.minFareRwf, 400);
  assert.equal(json.fare.motorcycle.midRateRwf, 117);
  assert.equal(typeof json.liveLocationSeconds, 'number');
});

await check('config advertises the auth providers', async () => {
  const { status, json } = await api('/api/config');
  assert.equal(status, 200);
  assert.ok('googleClientId' in json);
  assert.equal(json.otpDevMode, undefined, 'the API must not publish the SMS provider state');
});

await check('otp send rejects a number that is not Rwandan mobile', async () => {
  for (const phone of ['12345', '0678123456', '078812345']) {
    const { status, json } = await api('/api/auth/otp/send', { method: 'POST', body: { phone } });
    assert.equal(status, 422, `${phone} should be rejected, got ${status}`);
    assert.equal(json.error, 'invalid_phone');
  }
});

await check('otp send enforces the resend cooldown', async () => {
  const phone = phoneFor(9);
  assert.equal((await api('/api/auth/otp/send', { method: 'POST', body: { phone } })).status, 200);
  const again = await api('/api/auth/otp/send', { method: 'POST', body: { phone } });
  assert.equal(again.status, 429);
  assert.equal(again.json.error, 'otp_rate_limited');
});

await check('a wrong otp code costs an attempt then locks the challenge', async () => {
  const phone = phoneFor(8);
  const sent = await sendOtp(phone);
  const wrong = sent.devCode === '111111' ? '222222' : '111111';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const { status, json } = await api('/api/auth/otp/verify', { method: 'POST', body: { phone, code: wrong } });
    if (attempt < 4) {
      assert.equal(status, 401, `attempt ${attempt} should say the code is wrong, got ${status} ${JSON.stringify(json)}`);
      assert.equal(json.error, 'otp_invalid');
    } else {
      assert.equal(status, 429, `attempt ${attempt} should lock the challenge, got ${status} ${JSON.stringify(json)}`);
      assert.equal(json.error, 'otp_attempts_exceeded');
    }
  }
  const after = await api('/api/auth/otp/verify', { method: 'POST', body: { phone, code: sent.devCode } });
  assert.equal(after.json.error, 'otp_expired', 'the real code must be dead once the challenge is locked');
});

await check('an unknown phone verifies into a signup token, not an account', async () => {
  const phone = phoneFor(1);
  const json = await verifyOtp(phone);
  assert.equal(json.status, 'new');
  assert.ok(json.verifyToken?.length > 20);
  assert.equal(json.token, undefined, 'a brand-new phone must not receive a session token');
});

await check('signup refuses a missing, forged or borrowed verify token', async () => {
  const body = {
    names: 'No Token', phone: phoneFor(2), id_number: idFor(2), tin_number: tinFor(2),
    plate: plateFor('N'), vehicle_type: 'moto',
  };
  const none = await api('/api/auth/signup', { method: 'POST', body });
  assert.equal(none.status, 400);
  assert.equal(none.json.error, 'invalid_verify_token');

  const forged = await api('/api/auth/signup', { method: 'POST', body: { ...body, verify_token: 'abc.def.ghi' } });
  assert.equal(forged.status, 400);
  assert.equal(forged.json.error, 'invalid_verify_token');

  const borrowed = await signupTokenFor(phoneFor(2));
  const stolen = await api('/api/auth/signup', {
    method: 'POST',
    body: {
      names: 'No Token', phone: phoneFor(12), id_number: idFor(12), tin_number: tinFor(12),
      plate: plateFor('L'), vehicle_type: 'moto', verify_token: borrowed,
    },
  });
  assert.equal(stolen.status, 403);
  assert.equal(stolen.json.error, 'phone_not_verified', 'a code verified for one phone must not open an account for another');
});

await check('signup rejects bad KYC values before anything is stored', async () => {
  const base = {
    names: 'Bad KYC', phone: phoneFor(4), id_number: idFor(4), tin_number: tinFor(4),
    plate: plateFor('C'), vehicle_type: 'moto', verify_token: 'irrelevant.because.fields.lose',
  };
  const cases = [
    [{ id_number: '123456789012345' }, 'invalid_id_number'],
    [{ id_number: '11985001234567890' }, 'invalid_id_number'],
    [{ id_number: '1198500a00012345' }, 'invalid_id_number'],
    [{ tin_number: '12345' }, 'invalid_tin_number'],
    /* the 10 and 11 digit forms are RRA business VAT numbers, never a rider TIN */
    [{ tin_number: '1098765432' }, 'invalid_tin_number'],
    [{ tin_number: '10987654321' }, 'invalid_tin_number'],
    [{ names: 'X' }, 'invalid_names'],
    [{ plate: '!!!' }, 'invalid_plate'],
    [{ vehicle_type: 'bicycle' }, 'invalid_vehicle_type'],
    [{ phone: '0678123456' }, 'invalid_phone'],
    [{ phone: '078812345' }, 'invalid_phone'],
    [{ phone: '07881234567' }, 'invalid_phone'],
  ];
  for (const [patch, code] of cases) {
    const { status, json } = await api('/api/auth/signup', { method: 'POST', body: { ...base, ...patch } });
    assert.equal(status, 422, `${code} should be 422, got ${status} ${JSON.stringify(json)}`);
    assert.equal(json.error, code);
  }
  assert.equal((await api(`/api/drivers?q=${encodeURIComponent(plateFor('C'))}`)).json.drivers.length, 0);
});

await check('a credential lookup needs a phone that just proved itself', async () => {
  const bare = await api('/api/verify-tin', { method: 'POST', body: { tin_number: tinFor(3) } });
  assert.equal(bare.status, 400, `verify-tin with no token returned ${bare.status} ${JSON.stringify(bare.json)}`);
  assert.equal(bare.json.error, 'invalid_verify_token');

  const forged = await api('/api/verify-id', { method: 'POST', body: { id_number: idFor(3), verify_token: 'x.y.z' } });
  assert.equal(forged.status, 400);
  assert.equal(forged.json.error, 'invalid_verify_token');

  const token = await signupTokenFor(phoneFor(3));
  const short = await api('/api/verify-tin', { method: 'POST', body: { tin_number: '12345', verify_token: token } });
  assert.equal(short.status, 422, 'a badly formed TIN is refused before RRA is contacted');
  assert.equal(short.json.error, 'invalid_tin_number');
});

await check('the lookups report what they could actually reach', async () => {
  const health = (await api('/api/health')).json;
  const token = await signupTokenFor(phoneFor(5));

  const tin = await api('/api/verify-tin', { method: 'POST', body: { tin_number: tinFor(5), verify_token: token } });
  if (health.kyc.rra) {
    assert.equal(tin.status, 200, `RRA is wired but verify-tin returned ${tin.status} ${JSON.stringify(tin.json)}`);
    assert.equal(typeof tin.json.valid, 'boolean');
    assert.ok(tin.json.source, 'every verdict must name where it came from');
  } else {
    assert.equal(tin.status, 503, 'an unwired RRA must say so, never answer as if the TIN were fine');
    assert.equal(tin.json.error, 'tin_check_unavailable');
  }

  const id = await api('/api/verify-id', {
    method: 'POST', body: { id_number: idFor(5), names: 'Test Person', verify_token: token },
  });
  if (health.kyc.idProvider) {
    assert.equal(id.status, 200, `NIDA is wired but verify-id returned ${id.status} ${JSON.stringify(id.json)}`);
    assert.equal(typeof id.json.exists, 'boolean');
    assert.equal(id.json.name, undefined, 'the register must never hand a name back to a caller');
  } else {
    assert.equal(id.status, 503);
    assert.equal(id.json.error, 'id_check_unavailable');
  }
});

await check('an invented TIN is refused by RRA, or marked unchecked when RRA is not wired', async () => {
  const health = (await api('/api/health')).json;
  const { status, json } = await signupNew({
    names: 'Kyc Verdicts', phone: phoneFor(10), id_number: idFor(10), tin_number: tinFor(10),
    plate: plateFor('V'), vehicle_type: 'moto',
  });

  if (health.kyc.strict) {
    assert.ok([201, 422, 503].includes(status), `KYC_STRICT signup returned ${status} ${JSON.stringify(json)}`);
    if (status === 503) assert.equal(json.error, 'kyc_unreachable', 'strict mode must name the missing checks');
    if (status === 422) assert.equal(json.error, 'tin_not_found');
    return;
  }
  if (health.kyc.rra) {
    assert.equal(status, 422, `RRA answers, so an invented TIN cannot be filed, got ${status} ${JSON.stringify(json)}`);
    assert.equal(json.error, 'tin_not_found');
    return;
  }

  assert.equal(status, 201, `signup returned ${status} ${JSON.stringify(json)}`);
  const kyc = json.application.kyc;
  assert.ok(kyc, 'the application must expose its KYC verdicts');
  for (const field of ['tin', 'id', 'phone']) {
    assert.ok(['pass', 'fail', 'unchecked', 'unavailable'].includes(kyc[field]),
      `${field} verdict "${kyc[field]}" is not one of the four honest states`);
  }
  assert.equal(kyc.tin, 'unchecked', 'a format-checked TIN is never recorded as confirmed');
});

await check('signup submits an application that is pending, not active', async () => {
  const { status, json } = await signupNew({
    names: 'Test Alice', phone: phoneFor(1), id_number: idFor(1), tin_number: tinFor(1),
    plate: plateFor('A'), vehicle_type: 'moto',
  });
  assert.equal(status, 201);
  assert.equal(json.status, 'submitted');
  assert.equal(json.application.status, 'pending');
  assert.match(json.message, /approve/i);

  const login = await verifyOtp(phoneFor(1));
  assert.equal(login.status, 'pending', 'an existing phone must not hand out a signup token');
  assert.equal(login.verifyToken, undefined);
  assert.ok(login.token?.length > 20, 'a pending rider should get a read-only session token');
  driverToken = login.token;
  driverId = login.driver.id;
  assert.equal(login.driver.status, 'pending');
});

await check('signup rejects a plate, ID or TIN that is already on file', async () => {
  const cases = [
    [phoneFor(6), plateFor('A'), idFor(6), tinFor(6), 'plate_taken'],
    [phoneFor(7), plateFor('F'), idFor(1), tinFor(7), 'id_number_taken'],
    [phoneFor(13), plateFor('M'), idFor(13), tinFor(1), 'tin_number_taken'],
  ];
  for (const [phone, plate, id_number, tin_number, code] of cases) {
    const { status, json } = await signupNew({ names: 'Copycat', phone, id_number, tin_number, plate, vehicle_type: 'moto' });
    assert.equal(status, 409, `${code} should be 409, got ${status} ${JSON.stringify(json)}`);
    assert.equal(json.error, code);
  }
});

await check('a pending rider cannot go online or receive work', async () => {
  const online = await api('/api/drivers/me/online', { method: 'POST', token: driverToken, body: { online: true } });
  assert.equal(online.status, 403);
  assert.equal(online.json.error, 'account_pending');

  const listed = await api(`/api/drivers?q=${encodeURIComponent(plateFor('A'))}`);
  assert.equal(listed.json.drivers.length, 0, 'a pending rider must not appear in the public list');

  const bookings = await api('/api/requests', {
    method: 'POST',
    body: { driver_id: driverId, client_name: 'C', client_phone: '0788555123', kind: 'ride', origin: 'a', destination: 'b' },
  });
  assert.equal(bookings.status, 409);
  assert.equal(bookings.json.error, 'driver_unavailable');

  const mine = await api('/api/requests/me', { token: driverToken });
  assert.equal(mine.status, 403);
  assert.equal(mine.json.error, 'account_pending');
});

await check('a pending rider can prepare their own operating profile', async () => {
  const { status, json } = await api('/api/drivers/me', {
    method: 'PATCH', token: driverToken,
    body: { zone: 'Remera', zones: ['Remera', 'Kanombe'], price_per_km: 350, services: 'both', capacity: 1, available_slots: ['morning'] },
  });
  assert.equal(status, 200);
  assert.equal(json.driver.zone, 'Remera');
  assert.equal(json.driver.pricePerKm, 350);
});

await check('admin routes are closed to ordinary riders', async () => {
  assert.equal((await api('/api/admin/applications', { token: driverToken })).status, 403);
  assert.equal((await api('/api/admin/stats', { token: driverToken })).status, 403);
  assert.equal((await api('/api/admin/applications')).status, 401);
  assert.equal((await api('/api/admin/applications/1/verify', {
    method: 'POST', token: driverToken, body: { check: 'tin' },
  })).status, 403, 'a rider must not be able to order a KYC re-check');
});

await check('the admin phone verifies an OTP and gains admin powers', async () => {
  const login = await verifyOtp(ADMIN_PHONE);
  assert.ok(login.token, `admin login returned ${JSON.stringify(login)}`);
  assert.equal(login.driver.isAdmin, true, `${ADMIN_PHONE} is not an admin — the scratch seed did not promote it`);
  adminToken = login.token;
});

await check('admin sees the pending application and approves it', async () => {
  if (!adminToken) throw new Error('__SKIP__');
  const pending = await api('/api/admin/applications?status=pending', { token: adminToken });
  assert.equal(pending.status, 200, `applications returned ${JSON.stringify(pending.json)}`);
  const row = pending.json.applications.find((a) => a.phone === phoneFor(1));
  assert.ok(row, 'the submitted application is missing from the admin queue');
  assert.equal(row.idNumber, idFor(1));
  assert.equal(row.tinNumber, tinFor(1));
  assert.equal(row.status, 'pending');
  assert.ok(row.kyc && ['pass', 'fail', 'unchecked', 'unavailable'].includes(row.kyc.tin),
    `the queue must show the TIN verdict, got ${JSON.stringify(row.kyc)}`);

  const nonsense = await api(`/api/admin/applications/${row.id}/verify`, {
    method: 'POST', token: adminToken, body: { check: 'licence' },
  });
  assert.equal(nonsense.status, 422);
  assert.equal(nonsense.json.error, 'invalid_check');

  const recheck = await api(`/api/admin/applications/${row.id}/verify`, {
    method: 'POST', token: adminToken, body: { check: 'tin' },
  });
  const health = (await api('/api/health')).json;
  if (health.kyc.rra) {
    assert.equal(recheck.status, 200, `re-check returned ${recheck.status} ${JSON.stringify(recheck.json)}`);
    assert.ok(['pass', 'fail'].includes(recheck.json.status), 'a live RRA answer is either of the two verdicts');
    assert.equal(recheck.json.application.kyc.tin, recheck.json.status, 'the row and the verdict must agree');
  } else {
    assert.equal(recheck.status, 503, 'an unwired RRA must refuse, not report a verdict');
    assert.equal(recheck.json.error, 'tin_check_unavailable');
  }

  const approved = await api(`/api/admin/applications/${row.id}/decision`, {
    method: 'POST', token: adminToken, body: { action: 'approve' },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.application.status, 'approved');

  const twice = await api(`/api/admin/applications/${row.id}/decision`, {
    method: 'POST', token: adminToken, body: { action: 'approve' },
  });
  assert.equal(twice.status, 409);
  assert.equal(twice.json.error, 'already_reviewed');

  const nowOnline = await api('/api/drivers/me/online', { method: 'POST', token: driverToken, body: { online: true } });
  assert.equal(nowOnline.status, 200, `an approved rider could not go online: ${JSON.stringify(nowOnline.json)}`);
  assert.equal(nowOnline.json.driver.online, true);
});

await check('approval refuses a rider with no pricing, then accepts admin-entered details', async () => {
  if (!adminToken) throw new Error('__SKIP__');
  const { status, json } = await signupNew({
    names: 'No Profile', phone: phoneFor(14), id_number: idFor(14), tin_number: tinFor(14),
    plate: plateFor('G'), vehicle_type: 'car',
  });
  assert.equal(status, 201);
  const blocked = await api(`/api/admin/applications/${json.application.id}/decision`, {
    method: 'POST', token: adminToken, body: { action: 'approve' },
  });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.json.error, 'incomplete_profile');

  const inline = await api(`/api/admin/applications/${json.application.id}/decision`, {
    method: 'POST', token: adminToken,
    body: { action: 'approve', zone: 'Kicukiro', services: 'ride', price_per_km: 600, capacity: 4 },
  });
  assert.equal(inline.status, 200);
  assert.equal(inline.json.application.pricePerKm, 600);
});

await check('rejection is recorded and blocks the rider', async () => {
  if (!adminToken) throw new Error('__SKIP__');
  const { status, json } = await signupNew({
    names: 'Rejected Bob', phone: phoneFor(15), id_number: idFor(15), tin_number: tinFor(15),
    plate: plateFor('R'), vehicle_type: 'moto',
  });
  assert.equal(status, 201);
  const short = await api(`/api/admin/applications/${json.application.id}/decision`, {
    method: 'POST', token: adminToken, body: { action: 'reject', reason: 'no' },
  });
  assert.equal(short.status, 422, 'a one-word reason should be refused');

  const rejected = await api(`/api/admin/applications/${json.application.id}/decision`, {
    method: 'POST', token: adminToken, body: { action: 'reject', reason: 'The ID photo is unreadable.' },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.application.status, 'rejected');

  const login = await verifyOtp(phoneFor(15));
  assert.equal(login.status, 'rejected');
  assert.equal(login.token, undefined, 'a rejected rider must not get a session');
  assert.match(login.reason, /unreadable/);
});

await check('a second approved driver exists for isolation tests', async () => {
  if (!adminToken) throw new Error('__SKIP__');
  const signed = await signupNew({
    names: 'Test Carol', phone: phoneFor(16), id_number: idFor(16), tin_number: tinFor(16),
    plate: plateFor('D'), vehicle_type: 'car',
  });
  assert.equal(signed.status, 201);
  secondId = signed.json.application.id;
  secondToken = (await verifyOtp(phoneFor(16))).token;
  assert.ok(secondToken, 'the pending rider should have a session token');

  await api('/api/drivers/me', {
    method: 'PATCH', token: secondToken,
    body: { zone: 'Kicukiro', zones: ['Kicukiro'], price_per_km: 600, services: 'ride', capacity: 4 },
  });
  const approved = await api(`/api/admin/applications/${secondId}/decision`, {
    method: 'POST', token: adminToken, body: { action: 'approve' },
  });
  assert.equal(approved.json.application.status, 'approved');
  const go = await api('/api/drivers/me/online', { method: 'POST', token: secondToken, body: { online: true } });
  assert.equal(go.json.driver.online, true);
});

await check('protected routes need a valid token', async () => {
  assert.equal((await api('/api/auth/me')).status, 401);
  assert.equal((await api('/api/auth/me', { token: 'not.a.jwt' })).status, 401);
  const tampered = `${driverToken.split('.').slice(0, 2).join('.')}.AAAA`;
  assert.equal((await api('/api/auth/me', { token: tampered })).status, 401);
  assert.equal((await api('/api/auth/me', { token: driverToken })).json.driver.id, driverId);
});

await check('google sign-in fails closed without a client id', async () => {
  const config = await api('/api/config');
  const { status, json } = await api('/api/auth/google', { method: 'POST', body: { credential: 'a.b.c' } });
  if (!config.json.googleClientId) {
    assert.equal(status, 503);
    assert.equal(json.error, 'google_not_configured');
  } else {
    assert.equal(status, 401, `a forged credential must be refused, got ${status}`);
    assert.match(json.error, /^google_/);
  }
});

await check('search filters by zone, vehicle, service, online and text', async () => {
  const moto = await api('/api/drivers?vehicle_type=moto');
  assert.ok(moto.json.drivers.length >= 1);
  assert.ok(moto.json.drivers.every((d) => d.vehicleType === 'moto'), 'moto filter leaked cars');
  assert.ok(moto.json.drivers.every((d) => d.status === 'approved'), 'a non-approved driver was listed');

  const remera = await api('/api/drivers?zone=remera');
  assert.ok(remera.json.drivers.some((d) => d.id === driverId), 'driver missing in own zone');
  assert.ok(!remera.json.drivers.some((d) => d.id === secondId), 'wrong zone driver appeared');

  const extra = await api('/api/drivers?zone=Kanombe');
  assert.ok(extra.json.drivers.some((d) => d.id === driverId), 'driver missing in an extra zone');

  const partial = await api('/api/drivers?zone=kan');
  assert.equal(partial.json.drivers.length, 0, 'partial zone name should not match');

  const online = await api('/api/drivers?online=1');
  assert.ok(online.json.drivers.every((d) => d.online), 'offline driver appeared');

  const delivery = await api('/api/drivers?service=delivery');
  assert.ok(delivery.json.drivers.every((d) => ['delivery', 'both'].includes(d.services)), 'service filter wrong');

  const text = await api(`/api/drivers?q=${encodeURIComponent(plateFor('A'))}`);
  assert.equal(text.json.drivers.length, 1, 'text search should match only this run driver');
  assert.equal(text.json.drivers[0].id, driverId);

  const zones = await api('/api/zones');
  assert.ok(zones.json.zones.includes('Remera'), 'approved driver zone missing from /api/zones');
});

await check('online toggle changes visibility', async () => {
  const off = await api('/api/drivers/me/online', { method: 'POST', token: driverToken, body: { online: false } });
  assert.equal(off.json.driver.online, false);
  const listed = await api('/api/drivers?online=1');
  assert.ok(!listed.json.drivers.some((d) => d.id === driverId), 'offline driver still listed as online');
  const on = await api('/api/drivers/me/online', { method: 'POST', token: driverToken, body: { online: true } });
  assert.equal(on.json.driver.online, true);
});

await check("a moto trip is priced on the RURA table, not the rider's own rate", async () => {
  const { status, json } = await api('/api/requests', {
    method: 'POST',
    body: {
      driver_id: driverId, client_name: 'Client One', client_phone: '0788555123', kind: 'ride',
      origin: 'Remera', destination: 'Kanyamirambo', distance_km: 8.4, passengers: 1, note: 'two bags',
    },
  });
  assert.equal(status, 201);
  assert.equal(json.request.status, 'new');
  // 400 RWF for the first 2 km + 6.4 km x 117 RWF = 1148.8, rounded to the nearest 10.
  assert.equal(json.request.fareRwf, 1150, `RURA fare for 8.4 km should be 1150, got ${json.request.fareRwf}`);
  assert.match(json.request.fareBasis, /RURA/, `moto fare should cite the regulator, got ${json.request.fareBasis}`);
  assert.equal(json.request.distanceSource, 'manual');
  assert.deepEqual(json.fare_components.map((c) => c.type), ['first_band', 'mid_band']);
  assert.equal(json.driver.id, driverId);
  requestId = json.request.id;
});

await check('a car still prices on its own per-kilometre rate', async () => {
  const { status, json } = await api('/api/requests', {
    method: 'POST',
    body: {
      driver_id: secondId, client_name: 'Client Two', client_phone: '0788555124', kind: 'ride',
      origin: 'Kicukiro', destination: 'Nyabuga', distance_km: 8.4, passengers: 2,
    },
  });
  assert.equal(status, 201);
  assert.equal(json.request.fareRwf, 5040, `8.4 km x 600 RWF should be 5040, got ${json.request.fareRwf}`);
  assert.equal(json.request.fareBasis, 'driver_rate');
  await api(`/api/requests/${json.request.id}/status`, { method: 'PATCH', token: secondToken, body: { status: 'cancelled' } });
});

await check('request gates: offline driver, wrong service, over capacity', async () => {
  await api('/api/drivers/me/online', { method: 'POST', token: driverToken, body: { online: false } });
  const offline = await api('/api/requests', {
    method: 'POST',
    body: { driver_id: driverId, client_name: 'C', client_phone: '0788555123', kind: 'ride', origin: 'a', destination: 'b' },
  });
  assert.equal(offline.json.error, 'driver_offline');
  await api('/api/drivers/me/online', { method: 'POST', token: driverToken, body: { online: true } });

  const wrongService = await api('/api/requests', {
    method: 'POST',
    body: { driver_id: secondId, client_name: 'C', client_phone: '0788555123', kind: 'delivery', origin: 'a', destination: 'b' },
  });
  assert.equal(wrongService.json.error, 'service_not_offered');

  const tooMany = await api('/api/requests', {
    method: 'POST',
    body: { driver_id: driverId, client_name: 'C', client_phone: '0788555123', kind: 'ride', origin: 'a', destination: 'b', passengers: 3 },
  });
  assert.equal(tooMany.json.error, 'capacity_exceeded');
});

await check('driver dashboards only show their own requests', async () => {
  const mine = await api('/api/requests/me', { token: driverToken });
  assert.ok(mine.json.requests.some((r) => r.id === requestId), 'own request missing');
  const other = await api('/api/requests/me', { token: secondToken });
  assert.ok(!other.json.requests.some((r) => r.id === requestId), 'request leaked to another driver');
});

await check('status transitions follow the state machine', async () => {
  const unknown = await api(`/api/requests/${requestId}/status`, { method: 'PATCH', token: driverToken, body: { status: 'pending' } });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.json.error, 'invalid_status');

  const accepted = await api(`/api/requests/${requestId}/status`, { method: 'PATCH', token: driverToken, body: { status: 'accepted' } });
  assert.equal(accepted.json.request.status, 'accepted');
  assert.equal(accepted.json.driver.onTrip, true, 'accepting a trip must mark the rider as carrying a passenger');

  const backwards = await api(`/api/requests/${requestId}/status`, { method: 'PATCH', token: driverToken, body: { status: 'declined' } });
  assert.equal(backwards.status, 409);
  assert.equal(backwards.json.error, 'invalid_status_change');

  const steal = await api(`/api/requests/${requestId}/status`, { method: 'PATCH', token: secondToken, body: { status: 'completed' } });
  assert.equal(steal.status, 403);

  const completed = await api(`/api/requests/${requestId}/status`, { method: 'PATCH', token: driverToken, body: { status: 'completed' } });
  assert.equal(completed.json.request.status, 'completed');

  const afterEnd = await api(`/api/requests/${requestId}/status`, { method: 'PATCH', token: driverToken, body: { status: 'accepted' } });
  assert.equal(afterEnd.status, 409);
});

await check('a rider with a passenger is hidden until they say NDITEGUYE', async () => {
  await api('/api/drivers/me/online', { method: 'POST', token: driverToken, body: { online: true } });
  const first = await api('/api/requests', {
    method: 'POST',
    body: { driver_id: driverId, client_name: 'Busy Client', client_phone: '0788555333', kind: 'ride', origin: 'Remera', destination: 'Kanombe', distance_km: 4 },
  });
  assert.equal(first.status, 201);
  const busyId = first.json.request.id;

  await api(`/api/requests/${busyId}/status`, { method: 'PATCH', token: driverToken, body: { status: 'accepted' } });
  const riding = (await api('/api/drivers/me', { token: driverToken })).json.driver;
  assert.equal(riding.state, 'with_passenger');
  assert.equal(riding.onTrip, true);
  assert.ok(riding.online, 'a rider mid-trip is still online, just not free');

  const second = await api('/api/requests', {
    method: 'POST',
    body: { driver_id: driverId, client_name: 'Waiting Client', client_phone: '0788555444', kind: 'ride', origin: 'Remera', destination: 'Kicukiro', distance_km: 3 },
  });
  assert.equal(second.status, 409, 'a rider who is carrying someone cannot be booked');
  assert.equal(second.json.error, 'driver_busy');

  const freeList = await api('/api/drivers?available=1');
  assert.ok(!freeList.json.drivers.some((d) => d.id === driverId), 'a rider with a passenger must not be listed as available');

  const done = await api(`/api/requests/${busyId}/status`, { method: 'PATCH', token: driverToken, body: { status: 'completed' } });
  assert.equal(done.json.driver.onTrip, false);
  assert.equal(done.json.driver.online, false, 'after a trip the rider must declare themselves available again');
  const landed = (await api('/api/drivers/me', { token: driverToken })).json.driver;
  assert.equal(landed.state, 'offline');

  await api('/api/drivers/me/ready', { method: 'POST', token: driverToken, body: {} });
  const ready = (await api('/api/drivers/me', { token: driverToken })).json.driver;
  assert.equal(ready.state, 'available');
  const retry = await api('/api/requests', {
    method: 'POST',
    body: { driver_id: driverId, client_name: 'Waiting Client', client_phone: '0788555444', kind: 'ride', origin: 'Remera', destination: 'Kicukiro', distance_km: 3 },
  });
  assert.equal(retry.status, 201, 'once the rider says NDITEGUYE the same booking goes through');
  await api(`/api/requests/${retry.json.request.id}/status`, { method: 'PATCH', token: driverToken, body: { status: 'cancelled' } });
});

await check('a rider posting their GPS fix shows up live and nearby', async () => {
  const bad = await api('/api/drivers/me/location', { method: 'POST', token: driverToken, body: { lat: 200, lng: 30 } });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error, 'invalid_lat');
  assert.equal((await api('/api/drivers/me/location', { method: 'POST', body: { lat: 1, lng: 2 } })).status, 401);

  const posted = await api('/api/drivers/me/location', {
    method: 'POST', token: driverToken, body: { lat: -1.9539, lng: 30.0586, accuracy: 25 },
  });
  assert.equal(posted.status, 200);
  assert.equal(posted.json.driver.live, true);
  assert.ok(posted.json.driver.locAgeSeconds <= 2, `fix should be fresh, got ${posted.json.driver.locAgeSeconds}s`);
  assert.equal(posted.json.accuracy_m, 25);
  assert.ok(posted.json.live_within_seconds > 0);

  // Kigali centre is about 1.6 km from the search origin used below.
  const near = await api('/api/drivers?near=-1.9400,30.0600&max_km=5');
  assert.ok(near.json.near, 'a near search must echo the origin');
  const me = near.json.drivers.find((d) => d.id === driverId);
  assert.ok(me, 'the rider who just posted a fix should be nearby');
  assert.ok(me.distanceKm > 1 && me.distanceKm < 3, `expected about 1.6 km, got ${me.distanceKm}`);
  assert.equal(me.live, true);

  const far = await api('/api/drivers?near=-1.9400,30.0600&max_km=0.5');
  assert.ok(!far.json.drivers.some((d) => d.id === driverId), 'a 0.5 km radius should not list a rider 1.6 km away');

  const ranked = await api('/api/drivers?near=-1.9400,30.0600&max_km=200');
  const liveFlags = ranked.json.drivers.map((d) => d.live);
  const lastLive = liveFlags.lastIndexOf(true);
  const firstStale = liveFlags.indexOf(false);
  assert.ok(firstStale === -1 || lastLive < firstStale, 'live riders must rank ahead of those without a fresh fix');

  const gone = await api('/api/drivers/me/online', { method: 'POST', token: driverToken, body: { online: false } });
  assert.equal(gone.json.driver.lat, null, 'going offline must drop the rider from the live map');
  assert.equal(gone.json.driver.live, false);
  await api('/api/drivers/me/online', { method: 'POST', token: driverToken, body: { online: true } });
});

/* ---- Rwanda's administrative divisions: the tree the dropdowns walk, and the two divisions a rider row carries ---- */

const DIVISION_COUNTS = { province: 5, district: 30, sector: 416, cell: 2149, village: 14837 };
const SEED_FILE = path.join(ROOT, 'data', 'locations.json');

await check('every level of the Rwandan register is loaded and counted', async () => {
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const health = (await api('/api/health')).json;
  const levels = await api('/api/locations/levels');
  assert.equal(levels.status, 200);
  assert.equal(health.divisions.loaded, 17437, 'the database lost rows between the seed file and SQLite');
  assert.equal(levels.json.total, health.divisions.loaded, 'health and the levels endpoint must agree');
  for (const [key, count] of Object.entries(DIVISION_COUNTS)) {
    assert.equal(seed.counts[`${key}s`], count, `the seed file itself no longer holds ${count} ${key} rows`);
    const row = levels.json.levels.find((entry) => entry.key === key);
    assert.ok(row, `level ${key} is missing from /api/locations/levels`);
    assert.equal(row.count, count);
  }
  assert.ok(health.divisions.centroids > 0, 'a GPS fix cannot be placed without sector centroids');
});

await check('each dropdown lists the children of what the rider just picked', async () => {
  const provinces = await api('/api/locations?level=province&lang=rw');
  assert.equal(provinces.status, 200);
  const kigali = provinces.json.items.find((row) => row.code === 'kigali-city');
  assert.equal(kigali.name, 'Umujyi wa Kigali', 'lang=rw must answer with the Kinyarwanda name');
  assert.equal(kigali.hasChildren, true);
  assert.equal(kigali.levelKey, 'province');

  const districts = await api('/api/locations?parent=kigali-city');
  assert.equal(districts.json.parent, 'kigali-city');
  assert.equal(districts.json.level, 'district');
  assert.deepEqual(districts.json.items.map((row) => row.code).sort(),
    ['kigali-city-gasabo', 'kigali-city-kicukiro', 'kigali-city-nyarugenge']);

  const cells = await api('/api/locations?parent=kigali-city-gasabo-remera&lang=rw');
  assert.equal(cells.json.total, cells.json.items.length, 'total must count the matches, not the page');
  assert.deepEqual(cells.json.items.map((row) => row.code).sort(),
    ['kigali-city-gasabo-remera-nyabisindu', 'kigali-city-gasabo-remera-nyarutarama',
      'kigali-city-gasabo-remera-rukiri-i', 'kigali-city-gasabo-remera-rukiri-ii']);

  const villages = await api('/api/locations?parent=kigali-city-gasabo-remera-nyabisindu');
  assert.equal(villages.json.total, 7);
  assert.equal(villages.json.truncated, false);
  assert.equal(villages.json.items.every((row) => row.hasChildren === false), true, 'a village is the last level');

  const page = await api('/api/locations?parent=kigali-city-gasabo-remera-nyabisindu&limit=3');
  assert.equal(page.json.items.length, 3);
  assert.equal(page.json.truncated, true, 'a cut-off list must say so instead of looking short');

  const english = await api('/api/locations?level=province&lang=en');
  const rw = await api('/api/locations?level=province&lang=rw');
  const kigaliEn = english.json.items.find((row) => row.code === 'kigali-city');
  const kigaliRw = rw.json.items.find((row) => row.code === 'kigali-city');
  assert.equal(kigaliEn.name, 'Kigali City');
  assert.equal(kigaliRw.name, 'Umujyi wa Kigali', 'the same code must answer in the language the page asked for');

  const noLang = await api('/api/locations?level=province');
  assert.equal(noLang.json.items.find((row) => row.code === 'kigali-city').name, 'Kigali City',
    'with no lang the server answers in English, so a page must always ask for its own');
});

await check('the division endpoints fail with codes the frontend can translate', async () => {
  const noQuery = await api('/api/locations');
  assert.equal(noQuery.status, 422);
  assert.equal(noQuery.json.error, 'invalid_query');

  const badLevel = await api('/api/locations?level=subcounty');
  assert.equal(badLevel.status, 422);
  assert.equal(badLevel.json.error, 'invalid_level');

  const unknownParent = await api('/api/locations?parent=kigali-city-neverland');
  assert.equal(unknownParent.status, 404);
  assert.equal(unknownParent.json.error, 'division_not_found');

  const shortSearch = await api('/api/locations/search?q=R');
  assert.equal(shortSearch.status, 422);
  assert.equal(shortSearch.json.error, 'invalid_query');

  const badChain = await api('/api/locations/chain?code=not-a-code!');
  assert.equal(badChain.status, 422);
  assert.equal(badChain.json.error, 'invalid_code');

  const badPoint = await api('/api/locations/point?lat=99&lng=30');
  assert.equal(badPoint.status, 422);
  assert.equal(badPoint.json.error, 'invalid_lat');
});

await check('one search box finds a place at any level and the chain endpoint draws the path', async () => {
  const cell = await api('/api/locations/search?q=Nyarutarama&lang=rw');
  assert.equal(cell.status, 200);
  const found = cell.json.items.find((row) => row.code === 'kigali-city-gasabo-remera-nyarutarama');
  assert.ok(found, `the cell must be searchable: ${JSON.stringify(cell.json.items)}`);
  assert.equal(found.levelKey, 'cell');
  assert.equal(found.parent, 'kigali-city-gasabo-remera');
  assert.equal(found.name, 'Nyarutarama');
  assert.match(found.label, /Umujyi wa Kigali.*Gasabo.*Remera.*Nyarutarama/, 'a result must show one line of context');

  const chain = await api('/api/locations/chain?code=kigali-city-gasabo-remera-nyarutarama&lang=rw');
  assert.equal(chain.status, 200);
  assert.equal(chain.json.levelKey, 'cell');
  assert.equal(chain.json.hasChildren, true);
  assert.deepEqual(chain.json.chain.map((entry) => entry.name),
    ['Umujyi wa Kigali', 'Gasabo', 'Remera', 'Nyarutarama']);

  const village = await api('/api/locations/search?q=Gihogere');
  assert.ok(village.json.items.some((row) => row.levelKey === 'village'), 'villages must come back too');

  const narrowed = await api('/api/locations/search?q=Remera&level=sector');
  assert.ok(narrowed.json.items.length > 0 && narrowed.json.items.every((row) => row.levelKey === 'sector'),
    'a level filter must not mix sectors with cells');
});

await check('a GPS fix answers the deepest division it can honestly prove', async () => {
  const point = await api('/api/locations/point?lat=-1.9429&lng=30.0641');
  assert.equal(point.status, 200);
  assert.equal(point.json.approximate, true, 'a centroid match is a nearest centre, never a boundary');
  assert.equal(point.json.levelKey, 'sector');
  assert.ok(point.json.distance_to_centre_km > 0, 'the answer must admit how far the centre is');
  assert.equal(point.json.chain.length, 3);

  const deep = await api('/api/locations/point?lat=-1.05&lng=30.05');
  assert.equal(deep.status, 200, 'a point with no sector near it must still place inside its province');
  assert.ok(deep.json.level < 3, `expected a shallow answer, got level ${deep.json.level}`);
});

await check('a rider picks the division they work in from the dropdowns', async () => {
  const picked = await api('/api/drivers/me', {
    method: 'PATCH', token: driverToken, body: { location_code: 'kigali-city-gasabo-remera-nyarutarama' },
  });
  assert.equal(picked.status, 200);
  assert.equal(picked.json.driver.area.code, 'kigali-city-gasabo-remera-nyarutarama');
  assert.equal(picked.json.driver.area.levelKey, 'cell');
  assert.equal(picked.json.driver.area.label, 'Kigali City, Gasabo, Remera, Nyarutarama',
    'with no lang the server answers in English, so every dashboard call must carry its own');
  assert.equal(picked.json.driver.zone, 'Nyarutarama, Remera', 'the old zone label must follow the picked division');

  const rw = await api('/api/drivers/me?lang=rw', { token: driverToken });
  assert.equal(rw.json.driver.area.name, 'Nyarutarama');
  assert.equal(rw.json.driver.area.label, 'Umujyi wa Kigali, Gasabo, Remera, Nyarutarama');
  assert.equal(rw.json.driver.area.path.map((entry) => entry.levelKey).join('>'), 'province>district>sector>cell');

  const invented = await api('/api/drivers/me', {
    method: 'PATCH', token: driverToken, body: { location_code: 'kigali-city-gasabo-neverland' },
  });
  assert.equal(invented.status, 404);
  assert.equal(invented.json.error, 'division_not_found');

  const malformed = await api('/api/drivers/me', {
    method: 'PATCH', token: driverToken, body: { location_code: 'Remera, Gasabo!' },
  });
  assert.equal(malformed.status, 422);
  assert.equal(malformed.json.error, 'invalid_location_code');
});

await check('a division search finds riders by where they work or where they were last seen', async () => {
  await api('/api/drivers/me/location', {
    method: 'POST', token: driverToken, body: { lat: -1.9429, lng: 30.0641, accuracy: 20 },
  });
  const seen = await api('/api/drivers?division=kigali-city-nyarugenge-kimisagara');
  assert.equal(seen.status, 200);
  assert.equal(seen.json.division.code, 'kigali-city-nyarugenge-kimisagara');
  assert.ok(seen.json.drivers.some((d) => d.id === driverId),
    'a rider whose last fix fell in that sector must appear even though they work in Gasabo');
  const me = seen.json.drivers.find((d) => d.id === driverId);
  assert.equal(me.area.code, 'kigali-city-gasabo-remera-nyarutarama');
  assert.equal(me.around.code, 'kigali-city-nyarugenge-kimisagara');
  assert.equal(me.around.levelKey, 'sector');
  assert.equal(me.around.path.length, 3);

  const wholeCity = await api('/api/drivers?division=kigali-city');
  assert.ok(wholeCity.json.drivers.some((d) => d.id === driverId), 'a province filter must cover every district under it');

  const otherSide = await api('/api/drivers?division=western-province');
  assert.ok(!otherSide.json.drivers.some((d) => d.id === driverId), 'a rider must not leak into another province');
  assert.equal(otherSide.json.division.riders, otherSide.json.drivers.length);

  const gone = await api('/api/drivers/me/online', { method: 'POST', token: driverToken, body: { online: false } });
  assert.equal(gone.json.driver.around, null, 'an offline rider has no live position to advertise');
  const remembered = await api('/api/drivers?division=kigali-city-nyarugenge-kimisagara');
  assert.ok(remembered.json.drivers.some((d) => d.id === driverId),
    'last seen is not live: the rider still belongs to the sector they worked in');
  await api('/api/drivers/me/online', { method: 'POST', token: driverToken, body: { online: true } });

  const bad = await api('/api/drivers?division=nowhere-at-all');
  assert.equal(bad.status, 404);
  assert.equal(bad.json.error, 'division_not_found');
});

await check('the regulated fare table prices a journey by distance', async () => {
  const cases = [[1.5, 400], [8.4, 1150], [45, 5780], [2, 400], [2.1, 410]];
  for (const [km, expected] of cases) {
    const { status, json } = await api(`/api/fare?distance_km=${km}`);
    assert.equal(status, 200);
    assert.equal(json.fare_rwf, expected, `${km} km should cost ${expected} RWF, got ${json.fare_rwf}`);
    assert.match(json.basis, /RURA/);
  }
  const waiting = await api('/api/fare?distance_km=1&wait_minutes=25');
  assert.equal(waiting.json.fare_rwf, 720, `15 chargeable minutes x 21 RWF on top of 400, got ${waiting.json.fare_rwf}`);
  const car = await api('/api/fare?distance_km=10&vehicle=car&price_per_km=600');
  assert.equal(car.json.fare_rwf, 6000);
  const noRate = await api('/api/fare?distance_km=10&vehicle=car');
  assert.equal(noRate.json.fare_rwf, null);
  assert.equal(noRate.json.basis, 'no_rate');
  const missing = await api('/api/fare');
  assert.equal(missing.status, 422);
  assert.equal(missing.json.error, 'invalid_distance_km');
});

await check('OpenStreetMap measures a real Kigali journey, not a straight line', async () => {
  const { status, json } = await api('/api/fare?from=Remera&to=Kicukiro&near=-1.9539,30.0586');
  if (status === 422 && json.error === 'place_not_found') {
    console.log('       (no map service reachable — measurement check skipped)');
    throw new Error('__SKIP__');
  }
  assert.equal(status, 200);
  assert.ok(['osrm', 'cache', 'estimated'].includes(json.source), `unexpected distance source ${json.source}`);
  // The same name exists in Musanze and Ngoma; a 99 km answer means the wrong one was picked.
  assert.ok(json.distance_km > 1 && json.distance_km < 20, `Remera to Kicukiro should be a Kigali trip, got ${json.distance_km} km`);
  const bogus = await api('/api/fare?from=Qqwtvplmz&to=Jjklnmtrq');
  assert.equal(bogus.status, 422);
  assert.equal(bogus.json.error, 'place_not_found');
});

await check('a moto is approved without the admin setting a price', async () => {
  if (!adminToken) throw new Error('__SKIP__');
  const signed = await signupNew({
    names: 'No Price Moto', phone: phoneFor(21), id_number: idFor(21), tin_number: tinFor(21),
    plate: plateFor('P'), vehicle_type: 'moto',
  });
  assert.equal(signed.status, 201);
  const approved = await api(`/api/admin/applications/${signed.json.application.id}/decision`, {
    method: 'POST', token: adminToken, body: { action: 'approve', zone: 'Nyarugenge', services: 'ride' },
  });
  assert.equal(approved.status, 200, `a moto needs no per-km price to be approved: ${JSON.stringify(approved.json)}`);
  assert.equal(approved.json.application.pricePerKm, null);

  const login = await verifyOtp(phoneFor(21));
  const online = await api('/api/drivers/me/online', { method: 'POST', token: login.token, body: { online: true } });
  assert.equal(online.status, 200, `an unpriced moto could not go online: ${JSON.stringify(online.json)}`);
  assert.match(online.json.driver.fareBasis, /RURA/);
});

await check('ratings move the average', async () => {
  const before = (await api('/api/drivers')).json.drivers.find((d) => d.id === driverId);
  const after = (await api(`/api/drivers/${driverId}/rating`, { method: 'POST', body: { stars: 4 } })).json.driver;
  assert.equal(after.trips, before.trips + 1);
  assert.ok(after.rating >= 1 && after.rating <= 5);
  const bad = await api(`/api/drivers/${driverId}/rating`, { method: 'POST', body: { stars: 9 } });
  assert.equal(bad.status, 422);
});

await check('payment is refused before the trip is accepted', async () => {
  const fresh = await api('/api/requests', {
    method: 'POST',
    body: { driver_id: driverId, client_name: 'Unpaid', client_phone: '0788555222', kind: 'ride', origin: 'x', destination: 'y', distance_km: 2 },
  });
  const pay = await api(`/api/requests/${fresh.json.request.id}/payments`, {
    method: 'POST', token: driverToken, body: { provider: 'paystack', amount_rwf: 1500, email: 'payer@example.com' },
  });
  assert.equal(pay.status, 409);
  assert.equal(pay.json.error, 'not_payable');
});

await check('unknown provider is rejected', async () => {
  const { status, json } = await api(`/api/requests/${requestId}/payments`, {
    method: 'POST', token: driverToken, body: { provider: 'paypal', amount_rwf: 1000, email: 'a@b.com' },
  });
  assert.equal(status, 422);
  assert.equal(json.error, 'unknown_provider');
});

await check('earnings totals the driver join without SQL errors', async () => {
  const { status, json } = await api('/api/earnings', { token: driverToken });
  assert.equal(status, 200, `earnings failed: ${JSON.stringify(json)}`);
  assert.equal(typeof json.collected_rwf, 'number');
  assert.equal(json.collected_rwf, json.payout_rwf + json.fee_rwf, 'commission split must add up');
  assert.ok(Array.isArray(json.byProvider));
  assert.equal((await api('/api/earnings')).status, 401, 'earnings must require auth');
});

const server = (await api('/api/health')).json;

await check('webhook refuses a forged Paystack signature', async () => {
  const body = JSON.stringify({ event: 'charge.success', data: { reference: 'SM-PAYS-XYZ', status: 'success' } });
  const forged = await api('/api/webhooks/paystack', { method: 'POST', raw: body });
  if (server.providers.paystack) {
    assert.equal(forged.status, 401);
    assert.equal(forged.json.error, 'bad_webhook_signature');
  } else {
    assert.equal(forged.status, 503);
    assert.equal(forged.json.error, 'paystack_not_configured');
  }
});

if (PAYSTACK_KEY) {
  await check('webhook accepts a correctly signed payload', async () => {
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'SM-PAYS-UNKNOWN', status: 'success' } });
    const signature = crypto.createHmac('sha512', PAYSTACK_KEY).update(body).digest('hex');
    const response = await fetch(`${BASE}/api/webhooks/paystack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
      body,
    });
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.equal(json.ignored, 'unknown_reference');
  });
}

if (server.providers.paystack) {
  await check('Paystack calls really leave the server', async () => {
    const { status, json } = await api(`/api/requests/${requestId}/payments`, {
      method: 'POST', token: driverToken, body: { provider: 'paystack', email: 'payer@example.com' },
    });
    assert.equal(status, 502, `expected a real provider rejection, got ${status} ${JSON.stringify(json)}`);
    assert.equal(json.error, 'paystack_rejected');
    assert.match(json.message, /./);
  });
} else {
  await check('payment reports the provider as unconfigured', async () => {
    const { status, json } = await api(`/api/requests/${requestId}/payments`, {
      method: 'POST', token: driverToken, body: { provider: 'paystack', email: 'payer@example.com' },
    });
    assert.equal(status, 503);
    assert.equal(json.error, 'paystack_not_configured');
  });
}

if (server.providers.mtn_momo) {
  await check('MoMo calls really leave the server', async () => {
    const { status, json } = await api(`/api/requests/${requestId}/payments`, {
      method: 'POST', token: driverToken, body: { provider: 'mtn_momo', phone: '0788555222' },
    });
    assert.equal(status, 502, `expected a real MoMo rejection, got ${status} ${JSON.stringify(json)}`);
    assert.match(json.error, /^(momo_|provider_unreachable)/);
  });

  await check('MoMo webhook refuses a forged checksum', async () => {
    const body = JSON.stringify({ externalId: 'SM-MOMO-XYZ', status: 'SUCCESSFUL' });
    const forged = await api('/api/webhooks/mtn-momo', { method: 'POST', raw: body });
    assert.equal(forged.status, 401);
    assert.equal(forged.json.error, 'bad_webhook_signature');
  });
} else {
  await check('payment reports MoMo as unconfigured', async () => {
    const { status, json } = await api(`/api/requests/${requestId}/payments`, {
      method: 'POST', token: driverToken, body: { provider: 'mtn_momo', phone: '0788555222' },
    });
    assert.equal(status, 503);
    assert.equal(json.error, 'momo_not_configured');
  });
}

await check('admin stats counts the queue', async () => {
  if (!adminToken) throw new Error('__SKIP__');
  const { status, json } = await api('/api/admin/stats', { token: adminToken });
  assert.equal(status, 200);
  assert.ok(json.drivers.approved >= 2, 'this run approved at least two riders');
  assert.ok(json.drivers.pending >= 0 && json.drivers.rejected >= 0);
  assert.equal(typeof json.requests.total, 'number');
});

await check('rider document storage reports its real state', async () => {
  const { json } = await api('/api/health');
  assert.equal(typeof json.storage.configured, 'boolean');
  if (json.storage.configured) throw new Error('__SKIP__');
  const ticket = await api('/api/drivers/me/documents/national_id/upload-url', {
    method: 'POST', token: driverToken, body: { content_type: 'image/png' },
  });
  assert.equal(ticket.status, 503);
  assert.equal(ticket.json.error, 'storage_not_configured');
});

await check('bad JSON and unknown routes fail cleanly', async () => {
  const broken = await api('/api/requests', { method: 'POST', raw: '{not json' });
  assert.equal(broken.status, 400);
  assert.equal((await api('/api/nope')).status, 404);
});

console.log(`\n${passed} checks passed, ${failures.length} failed, ${skipped.length} skipped`);
if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exitCode = 1;
}

if (scratchChild) {
  clearTimeout(scratchWatchdog);
  scratchChild.kill();
  await sleep(400);
  await scratchPg?.stop();
}
process.exit(process.exitCode || 0);
