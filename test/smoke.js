import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';
import { runSeed, startPostgres, scratchEnv } from './pg-harness.js';
import { NUMVERIFY_TEST_KEY, startFakeNumverify } from './fake-numverify.js';
import { startFakeS3 } from './fake-s3.js';

/* The suite seeds and boots its own server against a throwaway database, so `npm test` cannot leave test
   accounts in live data. Set BASE_URL only when you deliberately want to run these checks against a server
   that is already running — that will create riders, trips and payments on that database. */
const ROOT = path.join(import.meta.dirname, '..');
const EXTERNAL = process.env.BASE_URL;
const PORT = Number(process.env.TEST_PORT || crypto.randomInt(4900, 5900));
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;

/* Read the same .env the server boots from, so `npm test` and the server can never disagree. */
const PAYSTACK_KEY = config.paystack.secretKey;

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
const letterFor = (n) => String.fromCharCode(65 + (Number(n) % 26));
const plateFor = (n) => `RAB ${tag.slice(0, 2)}${String(n).padStart(2, '0')} ${letterFor(n)}`;
const idFor = (n) => `1198500${tag}${String(n).padStart(4, '0')}`;
const tinFor = (n) => `10${tag}${String(n).padStart(2, '0')}`;
const emailFor = (n) => `rider${n}.${tag}@example.com`;

/* A rider opens an account with an email and a password, then files the paperwork against the session
   that account was just handed. The admin console is claimed by the first account to sign up with
   ADMIN_EMAIL, so that address is the one this suite signs up first. */
const ADMIN_EMAIL = config.adminEmail || `admin.${tag}@example.com`;
const PASS = 'scratch-password-2026';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const detailsFor = (n, patch = {}) => ({
  names: `Test Rider ${n}`, id_number: idFor(n), tin_number: tinFor(n), plate: plateFor(n),
  phone: phoneFor(n), vehicle_type: 'moto', ...patch,
});

/* The short-lived value the Google button hands back is signed with the server's own secret, which
   this suite shares through the environment — so a Google account can be opened without a Google
   client id. Minting it here, rather than importing src/auth.js, keeps the suite out of a module
   that connects to a database the moment it is loaded. */
function mintHandshake(claims, minutes = 15) {
  if (config.jwtSecret.length < 32) return null;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ ...claims, iat: now, exp: now + minutes * 60 })}`;
  return `${data}.${crypto.createHmac('sha256', config.jwtSecret).update(data).digest('base64url')}`;
}

async function signUp(email, passphrase = PASS) {
  return api('/api/auth/signup', { method: 'POST', body: { email, password: passphrase } });
}

async function logIn(email, passphrase = PASS) {
  return api('/api/auth/login', { method: 'POST', body: { email, password: passphrase } });
}

async function fileDetails(token, body) {
  return api('/api/auth/details', { method: 'POST', token, body });
}

/* The licence is a document in the bucket, so the whole upload road runs here: ask for a URL, put the
   bytes at it, then confirm — the same three calls the signup page makes. */
async function uploadLicence(token) {
  const ticket = await api('/api/drivers/me/documents/trading_licence/upload-url', {
    method: 'POST', token, body: { content_type: 'application/pdf' },
  });
  assert.equal(ticket.status, 200, `upload-url returned ${ticket.status} ${JSON.stringify(ticket.json)}`);
  const put = await fetch(ticket.json.uploadUrl, {
    method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: PDF,
  });
  assert.equal(put.status, 200, `the bucket refused the file with ${put.status}`);
  const done = await api('/api/drivers/me/documents/trading_licence/complete', { method: 'POST', token });
  assert.equal(done.status, 200, `complete returned ${done.status} ${JSON.stringify(done.json)}`);
  assert.equal(done.json.document.status, 'uploaded');
  return done.json.document;
}

/* False until health says the bucket is wired up; on an external BASE_URL it may stay false. */
let storageOn = false;

/* An account that has walked the whole road and is sitting in the admin queue. */
async function applyAs(n, patch = {}) {
  const email = emailFor(n);
  const signed = await signUp(email);
  assert.equal(signed.status, 201, `signup returned ${signed.status} ${JSON.stringify(signed.json)}`);
  const { token } = signed.json;
  if (storageOn) await uploadLicence(token);
  const filed = await fileDetails(token, detailsFor(n, patch));
  return { email, token, signed, filed };
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
let scratchNumverify = null;
let scratchS3 = null;

async function startScratchServer() {
  scratchPg = await startPostgres({ maxConnections: 12 });
  scratchNumverify = await startFakeNumverify();
  /* The trading licence is a required document, so the bucket has to be reachable for the details
     form to be filed at all — the suite cannot check the road a rider walks without it. */
  scratchS3 = await startFakeS3();
  const env = scratchEnv(scratchPg, {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    ADMIN_EMAIL,
    NUMVERIFY_ACCESS_KEY: NUMVERIFY_TEST_KEY,
    NUMVERIFY_BASE_URL: scratchNumverify.base,
    S3_ENDPOINT: scratchS3.endpoint,
    S3_REGION: 'us-east-1',
    S3_BUCKET: scratchS3.bucket,
    S3_ACCESS_KEY_ID: scratchS3.accessKeyId,
    S3_SECRET_ACCESS_KEY: scratchS3.secretAccessKey,
    S3_FORCE_PATH_STYLE: '1',
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

/* Every document check below branches on what the answering server really has wired up, not on what
   this test process was started with. */
storageOn = (await api('/api/health')).json.storage.configured;

await check('health reports the fourteen tables', async () => {
  const { status, json } = await api('/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.tables, 14);
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
  assert.equal(json.otpDevMode, undefined, 'the API must not publish how sign-in was reached');
});

await check('the phone door a rider used to sign in through is gone', async () => {
  for (const pathname of ['/api/auth/otp/send', '/api/auth/otp/verify', '/api/auth/phone/verify', '/api/auth/phone/send']) {
    const { status, json } = await api(pathname, { method: 'POST', body: { phone: phoneFor(9) } });
    assert.equal(status, 404, `${pathname} must no longer be routed, got ${status} ${JSON.stringify(json)}`);
    assert.equal(json.error, 'not_found');
  }
});

await check('signup needs an address a rider can read and the published password floor', async () => {
  const { json: cfg } = await api('/api/config');
  assert.equal(cfg.kyc.passwordMin, 8, 'the page and the server must agree on the password floor');

  const bare = await api('/api/auth/signup', { method: 'POST', body: { email: emailFor(30) } });
  assert.equal(bare.status, 422, `an account with no password must be refused, got ${bare.status}`);
  assert.equal(bare.json.error, 'invalid_password');

  for (const email of ['', 'no-at-sign', 'spaces in@example.com', 'a'.repeat(130)]) {
    const { status, json } = await api('/api/auth/signup', { method: 'POST', body: { email, password: PASS } });
    assert.equal(status, 422, `"${email.slice(0, 20)}" must be refused, got ${status}`);
    assert.equal(json.error, 'invalid_email');
  }

  const short = await api('/api/auth/signup', { method: 'POST', body: { email: emailFor(30), password: '1234' } });
  assert.equal(short.status, 422);
  assert.equal(short.json.error, 'invalid_password');
});

await check('the passenger door is budgeted per number', async () => {
  const health = (await api('/api/health')).json;
  if (!scratchNumverify || health.kyc.phoneCheck !== 'numverify') throw new Error('__SKIP__');
  const phone = `078${tag}99`;
  for (let call = 1; call <= 30; call += 1) {
    const { status } = await api('/api/passenger/auth/verify', { method: 'POST', body: { phone } });
    assert.equal(status, 200, `call ${call} should still be allowed, got ${status}`);
  }
  const before = scratchNumverify.calls.length;
  const blocked = await api('/api/passenger/auth/verify', { method: 'POST', body: { phone } });
  assert.equal(blocked.status, 429, `the 31st call must be refused, got ${blocked.status} ${JSON.stringify(blocked.json)}`);
  assert.equal(blocked.json.error, 'verify_rate_limited');
  assert.equal(scratchNumverify.calls.length, before, 'a refused request must not spend a lookup');
});

await check('a passenger number that is not Rwandan mobile is refused', async () => {
  for (const phone of ['12345', '0678123456', '078812345', '07881234567']) {
    const { status, json } = await api('/api/passenger/auth/verify', { method: 'POST', body: { phone } });
    assert.equal(status, 422, `${phone} should be rejected, got ${status}`);
    assert.equal(json.error, 'invalid_phone');
  }
});

await check('a new account is a draft with a session, not an application', async () => {
  const email = emailFor(2);
  const { status, json } = await signUp(email);
  assert.equal(status, 201, `signup returned ${status} ${JSON.stringify(json)}`);
  assert.equal(json.status, 'draft');
  assert.match(json.message, /complete your details/i);
  assert.ok(json.token?.length > 20, 'a draft still needs a session to file its paperwork with');
  assert.equal(json.driver.status, 'draft');
  assert.equal(json.driver.email, email);
  assert.equal(json.driver.hasPassword, true, 'an email account carries a password hash');
  assert.equal(json.driver.name, null, 'a draft has no name until the form is filed');

  const me = await api('/api/auth/me', { token: json.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.driver.status, 'draft');

  const again = await api('/api/auth/signup', { method: 'POST', body: { email: email.toUpperCase(), password: PASS } });
  assert.equal(again.status, 409, 'an address is one account whatever the casing it was typed in');
  assert.equal(again.json.error, 'email_taken');

  const online = await api('/api/drivers/me/online', { method: 'POST', token: json.token, body: { online: true } });
  assert.equal(online.status, 403, 'a draft must not reach the live map');
  assert.equal(online.json.error, 'account_pending');
});

await check('login answers a wrong password and an unknown address with the same words', async () => {
  const wrong = await logIn(emailFor(2), 'not-the-password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, 'invalid_credentials');

  const stranger = await logIn(`nobody.${tag}@example.com`);
  assert.equal(stranger.status, 401);
  assert.equal(stranger.json.error, 'invalid_credentials');
  assert.equal(stranger.json.message, wrong.json.message,
    'the two refusals must be identical, or the login form is a list of who has an account');

  const bad = await api('/api/auth/login', { method: 'POST', body: { email: 'still-not-an-email' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error, 'invalid_email');

  const good = await logIn(emailFor(2));
  assert.equal(good.status, 200);
  assert.equal(good.json.status, 'draft');
  assert.ok(good.json.token);
  assert.equal(good.json.driver.email, emailFor(2));
});

await check('a correct sign-in does not spend the login budget, a wrong one does', async () => {
  const email = emailFor(3);
  await signUp(email);
  for (let try1 = 1; try1 <= 12; try1 += 1) {
    const ok = await logIn(email);
    assert.equal(ok.status, 200, `attempt ${try1} of a correct password must never be capped, got ${ok.status}`);
  }
  for (let try1 = 1; try1 <= 10; try1 += 1) {
    const bad = await logIn(email, `wrong-${try1}`);
    assert.equal(bad.status, 401, `wrong attempt ${try1} must still be answered as a bad password`);
  }
  const locked = await logIn(email);
  assert.equal(locked.status, 429, `the eleventh wrong password must lock the account, got ${locked.status}`);
  assert.equal(locked.json.error, 'login_rate_limited');
});

/* A rider who came through the Google button has no password to type, so the login page has to say
   "use the Google button" instead of failing a guess that could never have been right. The handshake
   value is signed with this very server's secret, which the suite shares — against an external
   BASE_URL the mint is refused, and the check says so instead of passing quietly. */
await check('a Google account is sent back to the Google button', async () => {
  const email = emailFor(28);
  const subject = `google-${tag}-28`;
  const handshake = mintHandshake({ googleSubject: subject, googleEmail: email });
  if (!handshake) throw new Error('__SKIP__');

  const signed = await api('/api/auth/signup', { method: 'POST', body: { email, google_token: handshake } });
  if (signed.status === 400) {
    assert.equal(signed.json.error, 'invalid_google_token');
    throw new Error('__SKIP__');
  }
  assert.equal(signed.status, 201, `signup returned ${signed.status} ${JSON.stringify(signed.json)}`);
  assert.equal(signed.json.driver.hasPassword, false, 'a Google account carries no password hash');

  const typed = await logIn(email, PASS);
  assert.equal(typed.status, 403, `a password must not be tried against a Google account, got ${typed.status}`);
  assert.equal(typed.json.error, 'google_account_only');

  const twice = await api('/api/auth/signup', { method: 'POST', body: { email, password: PASS } });
  assert.equal(twice.status, 409);
  assert.equal(twice.json.error, 'email_taken');

  const forged = await api('/api/auth/signup', { method: 'POST', body: { email: emailFor(29), google_token: 'x.y.z' } });
  assert.equal(forged.status, 400);
  assert.equal(forged.json.error, 'invalid_google_token');

  const otherAddress = await api('/api/auth/signup', {
    method: 'POST',
    body: { email: emailFor(29), google_token: mintHandshake({ googleSubject: `google-${tag}-29`, googleEmail: `someone.${tag}@example.com` }) },
  });
  assert.equal(otherAddress.status, 403, 'a handshake must not be filed under an address Google did not vouch for');
  assert.equal(otherAddress.json.error, 'google_email_mismatch');

  const sameSubject = await api('/api/auth/signup', {
    method: 'POST', body: { email: emailFor(29), google_token: mintHandshake({ googleSubject: subject }) },
  });
  assert.equal(sameSubject.status, 409, `one Google account cannot hold two riders: ${JSON.stringify(sameSubject.json)}`);
  assert.equal(sameSubject.json.error, 'google_taken');
});

/* A draft session, for the checks that only need the form in front of them. */
async function draftFor(n) {
  const signed = await signUp(emailFor(n));
  assert.equal(signed.status, 201, `signup returned ${signed.status} ${JSON.stringify(signed.json)}`);
  return signed.json.token;
}

await check('the details form refuses a bad KYC value before anything is stored', async () => {
  const token = await draftFor(4);
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
    const { status, json } = await fileDetails(token, detailsFor(4, patch));
    assert.equal(status, 422, `${code} should be 422, got ${status} ${JSON.stringify(json)}`);
    assert.equal(json.error, code);
  }
  assert.equal((await api(`/api/drivers?q=${encodeURIComponent(plateFor(4))}`)).json.drivers.length, 0);
  const still = await api('/api/auth/me', { token });
  assert.equal(still.json.driver.status, 'draft', 'a refused form must leave the account a draft');
  assert.equal(still.json.driver.plate, null, 'a refused value must not be half-stored');
});

await check('an application cannot be filed without the trading licence', async () => {
  const { json: cfg } = await api('/api/config');
  assert.equal(cfg.documents.configured, storageOn, 'the page is told whether an upload is possible here');
  if (!storageOn) throw new Error('__SKIP__');
  const token = await draftFor(18);
  const { status, json } = await fileDetails(token, detailsFor(18));
  assert.equal(status, 422, `a licence-less application must be refused, got ${status} ${JSON.stringify(json)}`);
  assert.equal(json.error, 'licence_required');
  assert.match(json.message, /licence/i, 'the refusal must name the missing document');
});

await check('a rider uploads the trading licence and files it', async () => {
  if (!storageOn) throw new Error('__SKIP__');
  const token = await draftFor(8);

  const ticket = await api('/api/drivers/me/documents/trading_licence/upload-url', {
    method: 'POST', token, body: { content_type: 'application/pdf' },
  });
  assert.equal(ticket.status, 200, `upload-url returned ${ticket.status} ${JSON.stringify(ticket.json)}`);
  assert.ok(ticket.json.uploadUrl?.startsWith('http'), 'the browser needs a URL it can PUT at');
  assert.equal(ticket.json.maxBytes > 0, true, 'the page must be told the size ceiling');

  const put = await fetch(ticket.json.uploadUrl, {
    method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: PDF,
  });
  assert.equal(put.status, 200, `the bucket refused the file with ${put.status}`);

  const done = await api('/api/drivers/me/documents/trading_licence/complete', { method: 'POST', token });
  assert.equal(done.status, 200);
  assert.equal(done.json.document.status, 'uploaded');
  assert.equal(done.json.document.contentType, 'application/pdf');
  assert.equal(done.json.document.bytes, PDF.length, 'the bucket must report the bytes it really holds');

  const list = await api('/api/drivers/me/documents', { token });
  assert.equal(list.json.configured, true);
  assert.ok(list.json.documents.some((row) => row.kind === 'trading_licence' && row.status === 'uploaded'));

  const filed = await fileDetails(token, detailsFor(8));
  assert.equal(filed.status, 200, `filing returned ${filed.status} ${JSON.stringify(filed.json)}`);
  assert.equal(filed.json.status, 'submitted');
});

await check('the bucket only takes the file type a document really is', async () => {
  if (!storageOn) throw new Error('__SKIP__');
  const token = await draftFor(19);
  const pdf = await api('/api/drivers/me/documents/national_id/upload-url', {
    method: 'POST', token, body: { content_type: 'application/pdf' },
  });
  assert.equal(pdf.status, 422, `a PDF national ID must be refused, got ${pdf.status}`);
  assert.equal(pdf.json.error, 'unsupported_document_type');
  const kind = await api('/api/drivers/me/documents/nowhere/upload-url', {
    method: 'POST', token, body: { content_type: 'image/png' },
  });
  assert.equal(kind.status, 422);
  assert.equal(kind.json.error, 'invalid_kind');
  const early = await api('/api/drivers/me/documents/plate/complete', { method: 'POST', token });
  assert.equal(early.status, 404);
  assert.equal(early.json.error, 'document_not_started');
});

await check('a credential lookup needs a rider session, not a phone number', async () => {
  const bare = await api('/api/verify-tin', { method: 'POST', body: { tin_number: tinFor(5) } });
  assert.equal(bare.status, 401, `verify-tin with no session returned ${bare.status} ${JSON.stringify(bare.json)}`);
  assert.equal(bare.json.error, 'authentication_required');

  const forged = await api('/api/verify-id', {
    method: 'POST', token: 'x.y.z', body: { id_number: idFor(5) },
  });
  assert.equal(forged.status, 401);
  assert.equal(forged.json.error, 'authentication_required');

  const passenger = await api('/api/passenger/auth/verify', { method: 'POST', body: { phone: phoneFor(5) } });
  if (passenger.status === 200) {
    const wrongDoor = await api('/api/verify-tin', {
      method: 'POST', token: passenger.json.token, body: { tin_number: tinFor(5) },
    });
    assert.equal(wrongDoor.status, 401, 'a passenger session must not drive RRA');
  }

  const token = await draftFor(5);
  const short = await api('/api/verify-tin', { method: 'POST', token, body: { tin_number: '12345' } });
  assert.equal(short.status, 422, 'a badly formed TIN is refused before RRA is contacted');
  assert.equal(short.json.error, 'invalid_tin_number');
});

await check('the lookups report what they could actually reach', async () => {
  const health = (await api('/api/health')).json;
  const token = await draftFor(25);

  const tin = await api('/api/verify-tin', { method: 'POST', token, body: { tin_number: tinFor(25) } });
  if (health.kyc.rra) {
    assert.equal(tin.status, 200, `RRA is wired but verify-tin returned ${tin.status} ${JSON.stringify(tin.json)}`);
    assert.equal(typeof tin.json.valid, 'boolean');
    assert.ok(tin.json.source, 'every verdict must name where it came from');
  } else {
    assert.equal(tin.status, 503, 'an unwired RRA must say so, never answer as if the TIN were fine');
    assert.equal(tin.json.error, 'tin_check_unavailable');
  }

  const id = await api('/api/verify-id', {
    method: 'POST', token, body: { id_number: idFor(25), names: 'Test Person' },
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

await check('health names the service that checks phone numbers', async () => {
  const { json } = await api('/api/health');
  assert.ok([false, 'numverify', 'generic'].includes(json.kyc.phoneCheck),
    `phoneCheck must be false, "numverify" or "generic", got ${JSON.stringify(json.kyc.phoneCheck)}`);
  const { json: cfg } = await api('/api/config');
  assert.equal(cfg.kyc.phone, json.kyc.phoneCheck || null, 'the signup page must be told the same provider');
});

await check('a number the plan does not know cannot sign a passenger in', async () => {
  const health = (await api('/api/health')).json;
  if (!scratchNumverify || health.kyc.phoneCheck !== 'numverify') throw new Error('__SKIP__');
  const dead = `079${tag}01`;
  const before = scratchNumverify.calls.length;
  const { status, json } = await api('/api/passenger/auth/verify', { method: 'POST', body: { phone: dead } });
  assert.equal(status, 422, `a dead number returned ${status} ${JSON.stringify(json)}`);
  assert.equal(json.error, 'phone_invalid');
  assert.equal(json.token, undefined, 'a refused number must not receive a session');
  assert.ok(scratchNumverify.calls.some((call) => call.number === `+250${dead.slice(1)}`),
    'the digits must be sent to the phone service in international form');
  assert.ok(scratchNumverify.calls.every((call) => call.key === NUMVERIFY_TEST_KEY),
    'every lookup must carry the access key — in the query or in the apikey header');
  assert.equal(scratchNumverify.calls.length, before + 2,
    'a cached rejection is looked up again live, so a stale plan error cannot lock a subscriber out');
});

await check('a rider number that is not in the plan stops the application', async () => {
  const health = (await api('/api/health')).json;
  if (!scratchNumverify || health.kyc.phoneCheck !== 'numverify') throw new Error('__SKIP__');
  const token = await draftFor(27);
  if (storageOn) await uploadLicence(token);
  const { status, json } = await fileDetails(token, detailsFor(27, { phone: `079${tag}27` }));
  assert.equal(status, 422, `a dead number must not be filed as an application, got ${status} ${JSON.stringify(json)}`);
  assert.equal(json.error, 'phone_invalid');
  const me = await api('/api/auth/me', { token });
  assert.equal(me.json.driver.status, 'draft', 'a refused phone leaves the rider a draft, not a pending stranger');
});

await check('a screened number is cached, so the same digits are not looked up twice', async () => {
  const health = (await api('/api/health')).json;
  if (!scratchNumverify || health.kyc.phoneCheck !== 'numverify') throw new Error('__SKIP__');
  const phone = `078${tag}41`;
  const before = scratchNumverify.calls.length;
  assert.equal((await api('/api/passenger/auth/verify', { method: 'POST', body: { phone } })).status, 200);
  assert.equal(scratchNumverify.calls.length, before + 1, 'the first sign-in screens the number once');
  const again = await api('/api/passenger/auth/verify', { method: 'POST', body: { phone } });
  assert.equal(again.status, 200, `a cached pass must not turn into a rejection, got ${again.status} ${JSON.stringify(again.json)}`);
  assert.equal(scratchNumverify.calls.length, before + 1, 'the second sign-in must read the cached verdict');
});

/* The same outage answers the two doors differently, on purpose. For a passenger the phone IS the
   identity, so an unreadable numverify refuses the sign-in. For a rider it is one field of a form an
   admin still has to read, so the application goes through with the verdict recorded as
   "unavailable" rather than a rider being locked out because a third party is down. */
await check('a phone service that cannot answer refuses the door but not the paperwork', async () => {
  const health = (await api('/api/health')).json;
  if (!scratchNumverify || health.kyc.phoneCheck !== 'numverify' || health.kyc.strict) throw new Error('__SKIP__');
  const cases = [['down', `078${tag}42`, 31], ['gibberish', `078${tag}43`, 32], ['gateway_refusal', `078${tag}44`, 33]];
  for (const [mode, phone, n] of cases) {
    await scratchNumverify.setMode(mode);
    const door = await api('/api/passenger/auth/verify', { method: 'POST', body: { phone } });
    assert.equal(door.status, 502, `${mode}: an unreadable service must refuse the door, got ${door.status} ${JSON.stringify(door.json)}`);
    assert.equal(door.json.error, 'phone_check_unavailable');
    assert.equal(door.json.token, undefined, `${mode}: an outage must never hand out a session`);

    const token = await draftFor(n);
    if (storageOn) await uploadLicence(token);
    const filed = await fileDetails(token, detailsFor(n, { phone }));
    assert.equal(filed.status, 200, `${mode}: an outage must not stop an application, got ${filed.status} ${JSON.stringify(filed.json)}`);
    assert.equal(filed.json.application.kyc.phone, 'unavailable', `${mode}: the queue must show that the check never happened`);
  }
  await scratchNumverify.setMode('ok');
  const recovered = await api('/api/passenger/auth/verify', { method: 'POST', body: { phone: `078${tag}42` } });
  assert.equal(recovered.status, 200, 'the door opens again as soon as the service answers');
});

await check('an invented TIN is refused by RRA, or marked unchecked when RRA is not wired', async () => {
  const health = (await api('/api/health')).json;
  const token = await draftFor(10);
  if (storageOn) await uploadLicence(token);
  const { status, json } = await fileDetails(token, detailsFor(10, { names: 'Kyc Verdicts' }));

  if (health.kyc.strict) {
    assert.ok([200, 422, 503].includes(status), `KYC_STRICT details returned ${status} ${JSON.stringify(json)}`);
    if (status === 503) assert.equal(json.error, 'kyc_unreachable', 'strict mode must name the missing checks');
    if (status === 422) assert.ok(['tin_not_found', 'id_not_found', 'phone_invalid'].includes(json.error),
      `a strict refusal must name the register that said no, got ${json.error}`);
    return;
  }
  if (health.kyc.rra) {
    assert.equal(status, 422, `RRA answers, so an invented TIN cannot be filed, got ${status} ${JSON.stringify(json)}`);
    assert.equal(json.error, 'tin_not_found');
    return;
  }

  assert.equal(status, 200, `details returned ${status} ${JSON.stringify(json)}`);
  const kyc = json.application.kyc;
  assert.ok(kyc, 'the application must expose its KYC verdicts');
  for (const field of ['tin', 'id', 'phone']) {
    assert.ok(['pass', 'fail', 'unchecked', 'unavailable'].includes(kyc[field]),
      `${field} verdict "${kyc[field]}" is not one of the four honest states`);
  }
  assert.equal(kyc.tin, 'unchecked', 'a format-checked TIN is never recorded as confirmed');
});

await check('the details form submits an application that is pending, not active', async () => {
  const email = emailFor(1);
  const { token, filed } = await applyAs(1);
  const { status, json } = filed;
  assert.equal(status, 200, `details returned ${status} ${JSON.stringify(json)}`);
  assert.equal(json.status, 'submitted');
  assert.equal(json.application.status, 'pending');
  assert.match(json.message, /approve/i);
  assert.equal(json.application.email, email);
  assert.equal(json.application.name, 'Test Rider 1');
  assert.equal(json.application.plate, plateFor(1));
  assert.equal(json.application.idNumber, idFor(1));
  assert.equal(json.application.tinNumber, tinFor(1));

  driverToken = token;
  driverId = json.application.id;
  assert.ok(driverToken?.length > 20, 'a pending rider keeps the session they filed with');
  assert.equal(json.application.hasPassword, true);
  const again = await logIn(email);
  assert.equal(again.json.status, 'pending', 'signing in again must show the same pending state');
});

await check('an application cannot be filed twice', async () => {
  const twice = await fileDetails(driverToken, detailsFor(1, { plate: plateFor(20) }));
  assert.equal(twice.status, 409, `a second form must be refused, got ${twice.status} ${JSON.stringify(twice.json)}`);
  assert.equal(twice.json.error, 'details_already_filed');
});

await check('details rejects a plate, ID or TIN that is already on file', async () => {
  const cases = [
    [6, { plate: plateFor(1) }, 'plate_taken'],
    [7, { id_number: idFor(1) }, 'id_number_taken'],
    [13, { tin_number: tinFor(1) }, 'tin_number_taken'],
  ];
  for (const [n, patch, code] of cases) {
    const { filed } = await applyAs(n, patch);
    assert.equal(filed.status, 409, `${code} should be 409, got ${filed.status} ${JSON.stringify(filed.json)}`);
    assert.equal(filed.json.error, code);
  }
});

await check('a pending rider cannot go online or receive work', async () => {
  const online = await api('/api/drivers/me/online', { method: 'POST', token: driverToken, body: { online: true } });
  assert.equal(online.status, 403);
  assert.equal(online.json.error, 'account_pending');

  const listed = await api(`/api/drivers?q=${encodeURIComponent(plateFor(1))}`);
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

/* The console is not seeded with a password nobody chose: the first account to sign up with
   ADMIN_EMAIL is made an admin by the server itself, so the suite walks that exact road. */
await check('the admin address signs up and gains admin powers', async () => {
  const health = (await api('/api/health')).json;
  assert.equal(health.adminConfigured, true, 'the scratch server must be started with ADMIN_EMAIL');
  const signed = await signUp(ADMIN_EMAIL);
  assert.equal(signed.status, 201, `signup returned ${signed.status} ${JSON.stringify(signed.json)}`);
  assert.equal(signed.json.driver.isAdmin, true, `${ADMIN_EMAIL} is not an admin — the server did not claim it`);
  const login = await logIn(ADMIN_EMAIL);
  assert.equal(login.status, 200, `admin login returned ${JSON.stringify(login.json)}`);
  assert.equal(login.json.driver.isAdmin, true);
  adminToken = login.json.token;

  const closed = await api('/api/admin/stats', { token: adminToken });
  assert.equal(closed.status, 200, 'an admin must reach the console');
});

await check('admin sees the pending application and approves it', async () => {
  if (!adminToken) throw new Error('__SKIP__');
  const pending = await api('/api/admin/applications?status=pending', { token: adminToken });
  assert.equal(pending.status, 200, `applications returned ${JSON.stringify(pending.json)}`);
  const row = pending.json.applications.find((a) => a.email === emailFor(1));
  assert.ok(row, 'the submitted application is missing from the admin queue');
  assert.equal(row.idNumber, idFor(1));
  assert.equal(row.tinNumber, tinFor(1));
  assert.equal(row.phone, phoneFor(1));
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
  const { filed } = await applyAs(14, { names: 'No Profile', vehicle_type: 'car' });
  assert.equal(filed.status, 200, `details returned ${filed.status} ${JSON.stringify(filed.json)}`);
  const blocked = await api(`/api/admin/applications/${filed.json.application.id}/decision`, {
    method: 'POST', token: adminToken, body: { action: 'approve' },
  });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.json.error, 'incomplete_profile');

  const inline = await api(`/api/admin/applications/${filed.json.application.id}/decision`, {
    method: 'POST', token: adminToken,
    body: { action: 'approve', zone: 'Kicukiro', services: 'ride', price_per_km: 600, capacity: 4 },
  });
  assert.equal(inline.status, 200);
  assert.equal(inline.json.application.pricePerKm, 600);
});

await check('rejection is recorded and blocks the rider', async () => {
  if (!adminToken) throw new Error('__SKIP__');
  const { token, filed } = await applyAs(15, { names: 'Rejected Bob' });
  assert.equal(filed.status, 200, `details returned ${filed.status} ${JSON.stringify(filed.json)}`);
  const id = filed.json.application.id;
  const short = await api(`/api/admin/applications/${id}/decision`, {
    method: 'POST', token: adminToken, body: { action: 'reject', reason: 'no' },
  });
  assert.equal(short.status, 422, 'a one-word reason should be refused');

  const rejected = await api(`/api/admin/applications/${id}/decision`, {
    method: 'POST', token: adminToken, body: { action: 'reject', reason: 'The ID photo is unreadable.' },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.application.status, 'rejected');

  const login = await logIn(emailFor(15));
  assert.equal(login.status, 200);
  assert.equal(login.json.status, 'rejected');
  assert.equal(login.json.token, undefined, 'a rejected rider must not get a session');
  assert.match(login.json.reason, /unreadable/);

  const filedAgain = await fileDetails(token, detailsFor(15, { plate: plateFor(25) }));
  assert.equal(filedAgain.json.error, 'details_already_filed', 'a rejected rider cannot quietly re-file the same form');
});

await check('a second approved driver exists for isolation tests', async () => {
  if (!adminToken) throw new Error('__SKIP__');
  const { token, filed } = await applyAs(16, { names: 'Test Carol', vehicle_type: 'car' });
  assert.equal(filed.status, 200, `details returned ${filed.status} ${JSON.stringify(filed.json)}`);
  secondId = filed.json.application.id;
  secondToken = token;
  assert.ok(secondToken, 'the pending rider keeps the session they filed with');

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

  const text = await api(`/api/drivers?q=${encodeURIComponent(plateFor(1))}`);
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
  const { token, filed } = await applyAs(21, { names: 'No Price Moto' });
  assert.equal(filed.status, 200, `details returned ${filed.status} ${JSON.stringify(filed.json)}`);
  const approved = await api(`/api/admin/applications/${filed.json.application.id}/decision`, {
    method: 'POST', token: adminToken, body: { action: 'approve', zone: 'Nyarugenge', services: 'ride' },
  });
  assert.equal(approved.status, 200, `a moto needs no per-km price to be approved: ${JSON.stringify(approved.json)}`);
  assert.equal(approved.json.application.pricePerKm, null);

  const online = await api('/api/drivers/me/online', { method: 'POST', token, body: { online: true } });
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
  assert.equal(json.storage.configured, storageOn, 'health must describe the server that is answering');
  const { json: cfg } = await api('/api/config');
  assert.deepEqual(cfg.documentTypes.trading_licence,
    ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    'a trading licence may arrive as the paper PDF or a photo of it');

  if (!json.storage.configured) {
    const ticket = await api('/api/drivers/me/documents/national_id/upload-url', {
      method: 'POST', token: driverToken, body: { content_type: 'image/png' },
    });
    assert.equal(ticket.status, 503);
    assert.equal(ticket.json.error, 'storage_not_configured');
    return;
  }

  assert.ok(json.storage.maxUploadBytes > 0, 'the page must be told the size ceiling it will be held to');
  assert.equal(cfg.documents.maxBytes, json.storage.maxUploadBytes, 'config and health must agree on the ceiling');
  const list = await api('/api/drivers/me/documents', { token: driverToken });
  assert.equal(list.json.configured, true);
  const licence = list.json.documents.find((row) => row.kind === 'trading_licence');
  assert.ok(licence, 'the licence an admin approved on must still be listed');
  assert.equal(licence.status, 'uploaded');
  assert.match(licence.url, /^https?:/, 'an uploaded document must be readable again through a signed link');
});

/* A serverless bundle has no public/ on disk, so the landing page it serves comes from src/landing.js.
   That copy is generated, and a generated copy is only trustworthy while something checks it. */
await check('the traced landing copy matches public/index.html', async () => {
  const { LANDING_HTML } = await import('../src/landing.js');
  assert.equal(LANDING_HTML, fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'));
});

await check('the landing page answers the root path', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  assert.match(await res.text(), /<html lang="(rw|en)">/);
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
  await scratchNumverify?.stop();
  await scratchS3?.stop();
}
process.exit(process.exitCode || 0);
