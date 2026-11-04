/* SMS suite: the OTP adapter against a gateway that answers the way Africa's Talking does.

   The API and dashboards suites both run with no SMS provider configured, so the code that reads the
   provider's reply has never been exercised by a suite — which is exactly how a wrong field name
   survived long enough to break every live login. This suite boots a server that believes it is
   talking to Africa's Talking and checks what the passenger gets back when the gateway accepts, when
   it refuses the sender ID, and when it never accepted the credentials at all. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { runSeed, startPostgres, scratchEnv } from './pg-harness.js';
import { NUMVERIFY_TEST_KEY, startFakeNumverify } from './fake-numverify.js';
import { AT_TEST_KEY, AT_TEST_SENDER, AT_TEST_USER, startFakeAfricastalking } from './fake-africastalking.js';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = Number(process.env.TEST_PORT || crypto.randomInt(5900, 6900));
const BASE = `http://127.0.0.1:${PORT}`;

const tag = crypto.randomInt(10000, 99999).toString();
const phoneFor = (n) => `078${tag}${String(n).padStart(2, '0')}`;
const PHONE = phoneFor(30);
const REJECT_PHONE = phoneFor(31);
const EMPTY_PHONE = phoneFor(32);
const HTML_PHONE = phoneFor(33);
const DOWN_PHONE = phoneFor(34);
const CODE_ONLY_PHONE = phoneFor(35);

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pgInstance = await startPostgres();
const numverify = await startFakeNumverify();
const at = await startFakeAfricastalking();

/* No OTP_ECHO: with a provider configured the code must never come back in the response, so the only
   way the suite can prove a send is the gateway's own record of it. */
const env = scratchEnv(pgInstance, {
  PORT: String(PORT),
  HOST: '127.0.0.1',
  ADMIN_PHONE: phoneFor(90),
  OTP_RESEND_SECONDS: '1',
  OTP_MAX_PER_HOUR: '60',
  NUMVERIFY_ACCESS_KEY: NUMVERIFY_TEST_KEY,
  NUMVERIFY_BASE_URL: numverify.base,
  SMS_PROVIDER: 'africastalking',
  SMS_USERNAME: AT_TEST_USER,
  SMS_PROVIDER_KEY: AT_TEST_KEY,
  SMS_PROVIDER_URL: at.messagingUrl,
  SMS_SENDER_ID: AT_TEST_SENDER,
});

await runSeed(env);
const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (chunk) => { log += chunk; });
child.stderr.on('data', (chunk) => { log += chunk; });
let exitCode = null;
child.on('exit', (code) => { exitCode = code; });
process.on('exit', () => { child.kill(); at.stop(); numverify.stop(); });

const watchdog = setTimeout(() => {
  console.error(`\n[seremoto] sms suite timed out. Server log:\n${log}`);
  child.kill();
  process.exit(1);
}, 120000);

for (let attempt = 0; attempt < 80; attempt += 1) {
  if (exitCode !== null) throw new Error(`the sms server exited (${exitCode}) before it answered /api/health:\n${log}`);
  const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
  if (health?.ok) break;
  await wait(250);
}

console.log(`SERE Moto SMS suite on a scratch Postgres instance (${pgInstance.label}) behind a fake Africa's Talking gateway\n`);

const db = new pg.Pool({ connectionString: pgInstance.url, ssl: false, max: 1 });

await check('health reports the aggregator instead of dev mode', async () => {
  const { status, json } = await api('/api/health');
  assert.equal(status, 200);
  assert.equal(json.kyc.smsProvider, 'africastalking');
});

await check('a code sent through the gateway comes back as sent, not as a dev echo', async () => {
  const { status, json } = await api('/api/auth/otp/send', { method: 'POST', body: { phone: PHONE } });
  assert.equal(status, 200, `otp/send returned ${status} ${JSON.stringify(json)}`);
  assert.equal(json.sent, true);
  assert.equal(json.devCode, undefined, 'the API leaked the code while an SMS provider is configured');
  const call = at.calls.at(-1);
  assert.equal(call.key, AT_TEST_KEY, 'the apiKey header must carry SMS_PROVIDER_KEY');
  assert.equal(call.form.username, AT_TEST_USER, 'Africa\'s Talking needs the account username in the body');
  assert.equal(call.form.to, `+250${PHONE.slice(1)}`, 'numbers are sent in international form');
  assert.equal(call.form.from, AT_TEST_SENDER);
  assert.match(call.form.message, /\b\d{6}\b/, 'the message must carry the 6-digit code');
});

await check('the delivery evidence lands on the challenge row', async () => {
  const { rows } = await db.query(
    'SELECT provider, sms_ref FROM otp_challenges WHERE phone = $1 ORDER BY id DESC LIMIT 1',
    [PHONE],
  );
  assert.equal(rows.length, 1, 'no challenge row was written');
  assert.equal(rows[0].provider, 'africastalking');
  assert.match(String(rows[0].sms_ref), /^ATXid_/, 'the provider message id is what a delivery dispute is opened with');
});

await check('a verified code still signs the passenger in', async () => {
  const call = at.calls.at(-1);
  const code = call.form.message.match(/\b(\d{6})\b/)[1];
  const { status, json } = await api('/api/auth/otp/verify', { method: 'POST', body: { phone: PHONE, code } });
  assert.equal(status, 200, `otp/verify returned ${status} ${JSON.stringify(json)}`);
  assert.equal(json.status, 'new');
});

/* Every branch below puts the gateway into a mood; the mood is always dropped again even when the
   check fails, or one broken assertion would report every later check as the same outage. */
async function inMode(mode, fn) {
  await at.setMode(mode);
  try {
    return await fn();
  } finally {
    await at.setMode('ok');
  }
}

await check('an unregistered sender ID is refused with the provider reason', async () => {
  const { status, json } = await inMode('rejected', () => api('/api/auth/otp/send', { method: 'POST', body: { phone: REJECT_PHONE } }));
  assert.equal(status, 502, `a refused recipient must not look like a sent code, got ${status} ${JSON.stringify(json)}`);
  assert.equal(json.error, 'sms_send_failed');
  assert.match(json.message, /rejected by gateway/, `the passenger-side message dropped the reason: ${json.message}`);
});

await check('an empty Recipients list is a failure, not a silent success', async () => {
  const { status, json } = await inMode('empty', () => api('/api/auth/otp/send', { method: 'POST', body: { phone: EMPTY_PHONE } }));
  assert.equal(status, 502);
  assert.match(json.message, /queued nothing/i);
});

await check('a gateway that answers in HTML is reported as one', async () => {
  const { status, json } = await inMode('gibberish', () => api('/api/auth/otp/send', { method: 'POST', body: { phone: HTML_PHONE } }));
  assert.equal(status, 502);
  assert.match(json.message, /not JSON/i, `got ${json.message}`);
});

await check('a numeric-only acceptance is still an acceptance', async () => {
  const { status, json } = await inMode('wordless', () => api('/api/auth/otp/send', { method: 'POST', body: { phone: CODE_ONLY_PHONE } }));
  assert.equal(status, 200, `statusCode 101 without a word is Africa's Talking saying taken, got ${status} ${JSON.stringify(json)}`);
  assert.equal(json.sent, true);
});

await check('the gateway down is a 502 the operator can read', async () => {
  const { status, json } = await inMode('down', () => api('/api/auth/otp/send', { method: 'POST', body: { phone: DOWN_PHONE } }));
  assert.equal(status, 502);
  assert.match(json.message, /HTTP 500/);
});

/* The branches below drive the adapter in this process, because they need credentials the server
   child must never see: a revoked key and an account that sends from its default sender. */
const { config } = await import('../src/config.js');
const { sendSms } = await import('../src/sms.js');
const live = { ...config.sms };
const unit = (settings) => {
  Object.assign(config.sms, live, {
    provider: 'africastalking',
    username: AT_TEST_USER,
    key: AT_TEST_KEY,
    url: at.messagingUrl,
    sender: AT_TEST_SENDER,
    timeoutMs: 8000,
  }, settings);
};

await check('a revoked key surfaces the plain-text reason, not a bare HTTP 401', async () => {
  unit({ key: 'the-key-was-deleted' });
  await assert.rejects(() => sendSms(PHONE, 'code 123456'), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, 'sms_send_failed');
    assert.match(error.message, /HTTP 401: The supplied authentication is invalid/, error.message);
    return true;
  });
});

await check('no SMS_SENDER_ID leaves the account default sender in charge', async () => {
  unit({ sender: '' });
  const before = at.calls.length;
  await sendSms(PHONE, 'code 123456');
  const call = at.calls.at(-1);
  assert.ok(call.form.from === undefined, `an unset sender must be left out, not sent blank: ${JSON.stringify(call.form)}`);
  assert.equal(at.calls.length, before + 1);
});

await check('the adapter refuses a status the provider did not grant', async () => {
  unit({});
  try {
    await assert.rejects(() => inMode('rejected', () => sendSms(PHONE, 'code 123456')), (error) => {
      assert.equal(error.code, 'sms_send_failed');
      assert.match(error.message, /Invalid sender id/);
      return true;
    });
  } finally {
    Object.assign(config.sms, live);
  }
});

child.kill();
await at.stop();
await numverify.stop();
await db.end();
await pgInstance.stop();
clearTimeout(watchdog);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`\n${failures.join('\n')}\n\nServer log:\n${log}`);
  process.exit(1);
}
