/* Assistant suite: the booking interview against a gateway that answers the way an OpenAI-compatible
   chat API does.

   The API and dashboards suites run with no model configured, so the code that asks the model for
   wording — and the code that refuses to believe it — has never been exercised by a suite. This one
   boots a server pointed at a local stand-in and checks the two things that matter: every fact the
   model is shown was computed here (the places from the register, the rider count from the same 2 km
   search the list on screen runs), and a reply that cannot be read is answered as an error instead of
   being painted into the question slot. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { runSeed, startPostgres, scratchEnv } from './pg-harness.js';
import { AI_TEST_KEY, startFakeOpenai } from './fake-openai.js';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = Number(process.env.TEST_PORT || crypto.randomInt(6900, 7900));
const BASE = `http://127.0.0.1:${PORT}`;
/* A second port for the same binary with the model key taken away. */
const BARE = PORT + 1;

const tag = crypto.randomInt(10000, 99999).toString();
const phoneFor = (n) => `078${tag}${String(n).padStart(2, '0')}`;

/* Kigali's centre, and a rider parked 300 m away from it. */
const NEAR = '-1.9539,30.0603';
const CLOSE = { lat: -1.9552, lng: 30.0605 };

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

async function api(pathname, { method = 'GET', body, base = BASE } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* A server that answers /api/health, or an error carrying its own log — the suite never waits on a
   process that has already given up. */
async function startServer(serverEnv, port) {
  const made = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  made.stdout.on('data', (chunk) => { output += chunk; });
  made.stderr.on('data', (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (made.exitCode !== null) {
      throw new Error(`the server on port ${port} exited (${made.exitCode}) before it answered /api/health:\n${output}`);
    }
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
      .then((response) => response.json()).catch(() => null);
    if (health?.ok) return { made, log: () => output };
    await wait(250);
  }
  made.kill();
  throw new Error(`the server on port ${port} never answered /api/health:\n${output}`);
}

const pgInstance = await startPostgres();
const openai = await startFakeOpenai();

const env = scratchEnv(pgInstance, {
  PORT: String(PORT),
  HOST: '127.0.0.1',
  ADMIN_PHONE: phoneFor(90),
  OTP_RESEND_SECONDS: '1',
  AI_BASE_URL: openai.base,
  AI_API_KEY: AI_TEST_KEY,
  AI_MODEL: 'gpt-4o-suite',
});

await runSeed(env);
const db = new pg.Pool({ connectionString: pgInstance.url, ssl: false, max: 1 });
await db.query(
  `INSERT INTO drivers (phone, name, plate, vehicle_type, zone, status, is_online, on_trip, lat, lng, loc_at)
   VALUES ($1, 'Jean Bosco', $2, 'moto', 'Kigali', 'approved', 1, 0, $3, $4, datetime('now'))`,
  [phoneFor(50), `RA ${tag} A`, CLOSE.lat, CLOSE.lng],
);

const watchdog = setTimeout(() => {
  console.error('\n[seremoto] assistant suite timed out.');
  process.exit(1);
}, 180000);

const main = await startServer(env, PORT);
const child = main.made;
process.on('exit', () => { child.kill(); openai.stop(); });

console.log(`SERE Moto assistant suite on a scratch Postgres instance (${pgInstance.label}) behind a fake chat gateway\n`);

/* Puts the gateway in a mood and always takes it out again, so one bad reply cannot cascade into
   the checks that follow. */
async function inMode(mode, fn) {
  await openai.setMode(mode);
  try {
    return await fn();
  } finally {
    await openai.setMode('ok');
  }
}

const systemPrompt = () => {
  const call = openai.lastCall();
  const messages = call?.body?.messages || [];
  return String(messages.find((m) => m.role === 'system')?.content || '');
};

await check('health names the model the booking page is allowed to talk to', async () => {
  const { status, json } = await api('/api/health');
  assert.equal(status, 200);
  assert.equal(json.assistant.configured, true);
  assert.equal(json.assistant.model, 'gpt-4o-suite');
});

await check('the province question is worded by the model over its own API', async () => {
  const { status, json } = await api('/api/assistant', { method: 'POST', body: { locale: 'rw', stage: 'province' } });
  assert.equal(status, 200, `assistant returned ${status} ${JSON.stringify(json)}`);
  assert.ok(json.ask && json.ask.length < 90, `the question must be one short line: ${json.ask}`);
  const call = openai.lastCall();
  assert.equal(call.auth, `Bearer ${AI_TEST_KEY}`, 'the key is sent by the server, never by the browser');
  assert.equal(call.body.model, 'gpt-4o-suite');
  assert.equal(call.path, '/v1/chat/completions');
});

await check('the model is shown the provinces from the register, not a list of its own', async () => {
  await api('/api/assistant', { method: 'POST', body: { locale: 'en', stage: 'province' } });
  const prompt = systemPrompt();
  const { json: levels } = await api('/api/locations?level=province&lang=en');
  const names = levels.items.map((row) => row.name);
  assert.equal(names.length, 5, `the seed must carry five provinces, got ${names.length}`);
  const line = prompt.split('\n').find((row) => row.startsWith('PLACES ON OFFER'));
  assert.ok(line, 'the prompt never carried the places on offer');
  names.forEach((name) => assert.ok(line.includes(name), `province ${name} was missing from the prompt`));
});

await check('the rider count the model may mention is the live 2 km search, not a guess', async () => {
  const { status, json } = await api('/api/assistant', { method: 'POST', body: { locale: 'rw', stage: 'district', near: NEAR } });
  assert.equal(status, 200, `assistant returned ${status} ${JSON.stringify(json)}`);
  assert.equal(json.facts.riders.count, 1, 'the seeded rider parked 300 m away must be the count');
  assert.equal(json.facts.riders.max_km, 2);
  const prompt = systemPrompt();
  assert.match(prompt, /RIDERS WITHIN 2 KM RIGHT NOW: 1, closest is Jean Bosco/, 'the prompt must carry the same count the app shows');
});

await check('a passenger who has not shared a position is reported as unknown', async () => {
  await api('/api/assistant', { method: 'POST', body: { locale: 'en', stage: 'province' } });
  assert.match(systemPrompt(), /RIDERS NEARBY: unknown/);
});

await check('the price the model may repeat is the RURA table for a measured trip', async () => {
  const { status, json } = await api('/api/assistant', {
    method: 'POST',
    body: { locale: 'rw', stage: 'ready', destination: 'Kiyenga', distance_km: 7.4 },
  });
  assert.equal(status, 200, `assistant returned ${status} ${JSON.stringify(json)}`);
  assert.equal(json.facts.fare.distanceKm, 7.4);
  assert.equal(json.facts.fare.fareRwf, 1030, 'RURA: 400 for the first 2 km, then 117/km, rounded to the nearest 10');
  assert.match(systemPrompt(), /a 7\.4 km motorcycle trip is 1030 RWF/);
});

await check('the answer to a typed question is returned as a note, not as a new screen', async () => {
  await openai.setMode('answer');
  const { status, json } = await api('/api/assistant', {
    method: 'POST',
    body: { locale: 'rw', stage: 'ready', question: 'Hari moto hafi yanjye?', near: NEAR },
  });
  await openai.setMode('ok');
  assert.equal(status, 200, `assistant returned ${status} ${JSON.stringify(json)}`);
  assert.match(json.note, /abamotari 2/, 'the model answer is painted into the footnote line the page already has');
  const user = String(openai.lastCall().body.messages.find((m) => m.role === 'user')?.content || '');
  assert.match(user, /Hari moto hafi yanjye\?/, 'what the passenger typed must reach the model');
});

await check('a stage the interview never asks about is refused before the model is called', async () => {
  const before = openai.calls.length;
  const { status, json } = await api('/api/assistant', { method: 'POST', body: { stage: 'payment' } });
  assert.equal(status, 422, `expected 422, got ${status} ${JSON.stringify(json)}`);
  assert.equal(json.error, 'invalid_stage');
  assert.equal(openai.calls.length, before, 'a rejected request must not spend a model call');
});

await check('a model that answers in prose instead of the agreed shape is an error, not a question', async () => {
  await inMode('prose', async () => {
    const { status, json } = await api('/api/assistant', { method: 'POST', body: { stage: 'province' } });
    assert.equal(status, 502, `expected 502, got ${status} ${JSON.stringify(json)}`);
    assert.equal(json.error, 'ai_unavailable');
  });
});

await check('a wording too long for the question slot is dropped', async () => {
  await inMode('long', async () => {
    const { status, json } = await api('/api/assistant', { method: 'POST', body: { stage: 'province' } });
    assert.equal(status, 502, `expected 502, got ${status} ${JSON.stringify(json)}`);
    assert.equal(json.error, 'ai_unavailable');
  });
});

await check('a reply carrying markup or a link never reaches the page', async () => {
  await inMode('hostile', async () => {
    const { status, json } = await api('/api/assistant', { method: 'POST', body: { stage: 'province' } });
    assert.equal(status, 502, `expected 502, got ${status} ${JSON.stringify(json)}`);
    assert.equal(json.error, 'ai_unavailable');
  });
});

await check('a gateway that is down is reported as unavailable, with its own reason', async () => {
  await inMode('down', async () => {
    const { status, json } = await api('/api/assistant', { method: 'POST', body: { stage: 'province' } });
    assert.equal(status, 502, `expected 502, got ${status} ${JSON.stringify(json)}`);
    assert.match(json.message, /HTTP 500: The model service is overloaded/, json.message);
  });
});

await check('a key the provider rejects is surfaced, not swallowed', async () => {
  await openai.setKey('a-different-key');
  const { status, json } = await api('/api/assistant', { method: 'POST', body: { stage: 'province' } });
  await openai.setKey(AI_TEST_KEY);
  assert.equal(status, 502, `expected 502, got ${status} ${JSON.stringify(json)}`);
  assert.match(json.message, /Incorrect API key provided/, json.message);
});

await check('a reply with no message in it is unavailable, not an empty question', async () => {
  await inMode('nochoices', async () => {
    const { status, json } = await api('/api/assistant', { method: 'POST', body: { stage: 'province' } });
    assert.equal(status, 502, `expected 502, got ${status} ${JSON.stringify(json)}`);
    assert.match(json.message, /empty message/, json.message);
  });
});

await check('a gateway that answers in HTML is reported as not JSON', async () => {
  await inMode('html', async () => {
    const { status, json } = await api('/api/assistant', { method: 'POST', body: { stage: 'province' } });
    assert.equal(status, 502, `expected 502, got ${status} ${JSON.stringify(json)}`);
    assert.match(json.message, /not JSON/, json.message);
  });
});

await check('the booking page keeps its own questions when no model is configured', async () => {
  /* The same binary with the key taken away: the route must admit it has nobody to ask, so the page
     falls back to its scripted questions instead of showing a heading that came from nowhere. */
  const bareEnv = { ...env, DATABASE_POOL_MAX: '2' };
  delete bareEnv.AI_API_KEY;
  delete bareEnv.AI_MODEL;
  bareEnv.PORT = String(BARE);
  const before = openai.calls.length;
  const bare = await startServer(bareEnv, BARE);
  try {
    const health = await api('/api/health', { base: `http://127.0.0.1:${BARE}` });
    assert.equal(health.json.assistant.configured, false, 'health must say there is no model to ask');
    assert.equal(health.json.assistant.model, null);
    const answer = await api('/api/assistant', { method: 'POST', body: { stage: 'province' }, base: `http://127.0.0.1:${BARE}` });
    assert.equal(answer.status, 503, `expected 503, got ${answer.status} ${JSON.stringify(answer.json)}`);
    assert.equal(answer.json.error, 'ai_not_configured');
    assert.equal(openai.calls.length, before, 'a server with no key must not reach the gateway');
  } finally {
    bare.made.kill();
  }
});

child.kill();
await openai.stop();
await db.end();
await pgInstance.stop();
clearTimeout(watchdog);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`\n${failures.join('\n')}\n\nServer log:\n${main.log()}`);
  process.exit(1);
}
