/* Dashboards suite: passenger, rider and admin flows end to end.
   It seeds and boots its own server against a throwaway database in the temp folder, so it never
   touches live data and needs no payment provider credentials. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runSeed, startPostgres, scratchEnv } from './pg-harness.js';
import { startFakeS3 } from './fake-s3.js';

const PORT = Number(process.env.TEST_PORT || crypto.randomInt(3900, 4900));
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(import.meta.dirname, '..');
const pg = await startPostgres();
const s3 = await startFakeS3();

const SCRATCH_ENV = scratchEnv(pg, {
  PORT: String(PORT),
  HOST: '127.0.0.1',
  OTP_ECHO: '1',
  OTP_RESEND_SECONDS: '1',
  OTP_MAX_PER_HOUR: '60',
  S3_ENDPOINT: s3.endpoint,
  S3_REGION: 'us-east-1',
  S3_BUCKET: s3.bucket,
  S3_ACCESS_KEY_ID: s3.accessKeyId,
  S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
  S3_FORCE_PATH_STYLE: '1',
});

const tag = crypto.randomInt(10000, 99999).toString();
const phoneFor = (n) => `078${tag}${String(n).padStart(2, '0')}`;
const plateFor = (letter) => `RA ${tag.slice(0, 4)} ${letter}`;

const ADMIN_PHONE = phoneFor(90);
const RIDER_PHONE = phoneFor(10);
const SECOND_RIDER_PHONE = phoneFor(11);
const PASSENGER_PHONE = phoneFor(20);
const GUEST_PHONE = phoneFor(21);

SCRATCH_ENV.ADMIN_PHONE = ADMIN_PHONE;

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

async function api(pathname, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

const ok = (result, status, label) => {
  assert.equal(result.status, status, `${label} returned ${result.status} ${JSON.stringify(result.json)}`);
  return result.json;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function signIn(phone, endpoint = '/api/auth/otp/verify') {
  const sent = ok(await api('/api/auth/otp/send', { method: 'POST', body: { phone } }), 200, 'otp/send');
  assert.ok(sent.devCode, 'the scratch server must run with OTP_ECHO=1 so the suite can sign in');
  return ok(await api(endpoint, { method: 'POST', body: { phone, code: sent.devCode } }), 200, endpoint);
}

async function riderSignup(phone, names, plate) {
  const fresh = await signIn(phone);
  assert.equal(fresh.status, 'new', `expected a brand-new number, got ${JSON.stringify(fresh)}`);
  const suffix = phone.slice(-2);
  const created = await api('/api/auth/signup', {
    method: 'POST',
    body: {
      names,
      verify_token: fresh.verifyToken,
      id_number: `1198500${tag}${suffix}00`,
      tin_number: `10${tag}${suffix}`,
      plate,
      vehicle_type: 'moto',
      phone,
    },
  });
  assert.equal(created.status, 201, `signup returned ${created.status} ${JSON.stringify(created.json)}`);
  return created.json.application;
}

const book = (body, token) => api('/api/requests', {
  method: 'POST',
  token,
  body: { passengers: 1, origin: 'Kigali Heights', destination: 'Remera', ...body },
});

console.log(`\n[seremoto] dashboards suite on a scratch Postgres instance (${pg.label})`);
await runSeed(SCRATCH_ENV);

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: SCRATCH_ENV, stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
let childExitCode = null;
child.stdout.on('data', (chunk) => { bootLog += chunk; });
child.stderr.on('data', (chunk) => { bootLog += chunk; });
child.on('exit', (code) => { childExitCode = code; });

/* A stuck request must never leave the suite running forever against a half-dead scratch server. */
const watchdog = setTimeout(() => {
  console.error(`\n[seremoto] dashboards suite timed out. Scratch server log:\n${bootLog}`);
  child.kill();
  process.exit(1);
}, 120000);
process.on('exit', () => { clearTimeout(watchdog); child.kill(); });

async function waitForBoot() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (childExitCode !== null) throw new Error(`the scratch server exited (${childExitCode}) before it answered /api/health:\n${bootLog}`);
    const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })
      .then((response) => response.json()).catch(() => null);
    if (health?.ok) return health;
    await wait(250);
  }
  throw new Error(`the scratch server never came up:\n${bootLog}`);
}

let adminId;
let adminToken;
let riderId;
let riderToken;
let passengerToken;
let firstTripId;
let completedTripId;

try {
  const health = await waitForBoot();
  assert.equal(health.tables, 15, 'the divisions table must be created alongside the KYC check tables');
  assert.equal(health.drivers, 1, 'a scratch database starts with only the admin account');

  await check('admin signs in from the seeded ADMIN_PHONE account', async () => {
    const json = await signIn(ADMIN_PHONE);
    assert.equal(json.status, 'approved', `the admin must be pre-approved: ${JSON.stringify(json)}`);
    assert.ok(json.driver.isAdmin, 'the ADMIN_PHONE account must be marked admin');
    adminId = json.driver.id;
    adminToken = json.token;
  });

  await check('two riders sign up and wait for approval', async () => {
    const first = await riderSignup(RIDER_PHONE, 'Test Rider One', plateFor('A'));
    const second = await riderSignup(SECOND_RIDER_PHONE, 'Test Rider Two', plateFor('B'));
    assert.equal(first.status, 'pending');
    assert.equal(second.status, 'pending');
    const list = ok(await api('/api/admin/applications?status=pending', { token: adminToken }), 200, 'applications');
    assert.equal(list.applications.length, 2, 'both applications must be pending');
  });

  await check('pending rider cannot open the dashboard', async () => {
    const fresh = await signIn(RIDER_PHONE);
    assert.equal(fresh.status, 'pending');
    const blocked = await api('/api/drivers/me/requests', { token: fresh.token });
    assert.equal(blocked.status, 403, 'an unapproved rider must not list requests');
    assert.equal(blocked.json.error, 'account_pending');
  });

  await check('admin approves a rider with the operating details', async () => {
    const application = ok(await api('/api/admin/applications?status=pending', { token: adminToken }), 200, 'applications')
      .applications.find((row) => row.phone === RIDER_PHONE);
    const decision = ok(await api(`/api/admin/applications/${application.id}/decision`, {
      method: 'POST',
      token: adminToken,
      body: { action: 'approve', zone: 'Nyarutarama', services: 'both', capacity: 1 },
    }), 200, 'decision');
    assert.equal(decision.application.status, 'approved');
    riderId = application.id;
    riderToken = (await signIn(RIDER_PHONE)).token;
  });

  await check('NDITEGUYE puts the rider online and a GPS fix makes them live', async () => {
    const ready = ok(await api('/api/drivers/me/ready', { method: 'POST', token: riderToken, body: {} }), 200, 'ready');
    assert.equal(ready.driver.online, true);
    assert.equal(ready.driver.onTrip, false);
    assert.equal(ready.driver.state, 'available');
    const fixed = ok(await api('/api/drivers/me/location', {
      method: 'POST', token: riderToken, body: { lat: -1.9429, lng: 30.0641, accuracy: 12 },
    }), 200, 'location');
    assert.equal(fixed.driver.live, true, 'a fresh fix must make the rider live on the map');
    assert.ok(fixed.live_within_seconds > 0);
  });

  /* The console filter and the rider profile share one rule: a rider belongs to a division where they
     work or where their last fix fell — and the fix only ever says "around", not "in". */
  await check('a rider picks their working division and the console filters by it', async () => {
    const picked = ok(await api('/api/drivers/me', {
      method: 'PATCH', token: riderToken, body: { location_code: 'kigali-city-gasabo-remera-nyarutarama' },
    }), 200, 'profile');
    assert.equal(picked.driver.area.levelKey, 'cell');
    assert.equal(picked.driver.zone, 'Nyarutarama, Remera', 'the zone label the older screens show follows the pick');

    const all = ok(await api('/api/admin/riders', { token: adminToken }), 200, 'riders');
    const row = all.riders.find((rider) => rider.phone === RIDER_PHONE);
    assert.equal(all.division, null, 'an unfiltered list must not echo a division');
    assert.equal(row.area.code, 'kigali-city-gasabo-remera-nyarutarama');
    assert.equal(row.around.code, 'kigali-city-nyarugenge-kimisagara', 'the console sees which sector the last fix fell in');
    assert.equal(row.around.path[0].name, 'Kigali City');

    const city = ok(await api('/api/admin/riders?division=kigali-city', { token: adminToken }), 200, 'city');
    assert.equal(city.division.name, 'Kigali City');
    assert.equal(city.division.code, 'kigali-city');
    assert.equal(city.division.riders, city.riders.length, 'the echo must count what the page got');
    assert.ok(city.riders.some((rider) => rider.phone === RIDER_PHONE));

    const sector = ok(await api('/api/admin/riders?division=kigali-city-nyarugenge-kimisagara', { token: adminToken }), 200, 'sector');
    assert.ok(sector.riders.some((rider) => rider.phone === RIDER_PHONE),
      'a rider last seen in that sector belongs to it even though they work in Gasabo');

    const empty = ok(await api('/api/admin/riders?division=southern-province', { token: adminToken }), 200, 'south');
    assert.equal(empty.riders.length, 0, 'no rider in this run works or was seen in Southern Province');

    const rw = ok(await api('/api/admin/riders?division=kigali-city&lang=rw', { token: adminToken }), 200, 'rw');
    assert.equal(rw.division.name, 'Umujyi wa Kigali');
    assert.equal(rw.riders.find((rider) => rider.phone === RIDER_PHONE).area.path[0].name, 'Umujyi wa Kigali');

    const malformed = await api('/api/admin/riders?division=Remera%2C%20Gasabo!', { token: adminToken });
    assert.equal(malformed.status, 422);
    assert.equal(malformed.json.error, 'invalid_division');
    const invented = await api('/api/admin/riders?division=kigali-city-gasabo-nowhere', { token: adminToken });
    assert.equal(invented.status, 404);
    assert.equal(invented.json.error, 'division_not_found');
  });

  await check('a rider uploads KYC photos and the admin opens them with a signed link', async () => {
    const before = ok(await api('/api/drivers/me/documents', { token: riderToken }), 200, 'documents');
    assert.equal(before.configured, true);
    assert.equal(before.documents.length, 0);

    const rejected = await api('/api/drivers/me/documents/national_id/upload-url', {
      method: 'POST', token: riderToken, body: { content_type: 'text/html' },
    });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.json.error, 'unsupported_document_type');

    const ticket = ok(await api('/api/drivers/me/documents/national_id/upload-url', {
      method: 'POST', token: riderToken, body: { content_type: 'image/png' },
    }), 200, 'upload-url');
    assert.match(ticket.uploadUrl, /X-Amz-Signature=/, 'the rider must upload with a signed URL, never a key');

    const image = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4', 'hex');
    const put = await fetch(ticket.uploadUrl, {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: image,
    });
    assert.equal(put.status, 200, 'the signed PUT must reach the bucket');

    const pending = ok(await api('/api/drivers/me/documents/national_id/complete', {
      method: 'POST', token: riderToken,
    }), 200, 'complete');
    assert.equal(pending.document.status, 'uploaded');
    assert.equal(pending.document.bytes, image.length);
    assert.equal(pending.document.contentType, 'image/png');

    const missing = await api('/api/drivers/me/documents/driving_licence/complete', {
      method: 'POST', token: riderToken,
    });
    assert.equal(missing.status, 404, 'a document that was never started cannot be completed');

    const adminView = ok(await api(`/api/admin/riders/${riderId}/documents`, { token: adminToken }), 200, 'admin docs');
    assert.equal(adminView.documents.length, 1);
    assert.equal(adminView.documents[0].kind, 'national_id');
    assert.equal(adminView.documents[0].status, 'uploaded');
    const file = await fetch(adminView.documents[0].url);
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), image, 'the admin link must return the exact file');
  });

  await check('passenger books as a guest, then claims the trip with phone + OTP', async () => {
    const listed = ok(await api('/api/drivers?available=1', {}), 200, 'drivers');
    const rider = listed.drivers.find((row) => row.phone === RIDER_PHONE);
    assert.ok(rider, 'the approved online rider must be listed');
    const booked = ok(await book({
      driver_id: rider.id, kind: 'ride', client_name: 'Test Guest', client_phone: PASSENGER_PHONE, distance_km: 6,
    }), 201, 'requests');
    assert.equal(booked.request.passengerId, null, 'a guest booking has no passenger yet');
    assert.ok(booked.request.fareRwf > 0, 'the RURA fare must be priced server-side');
    firstTripId = booked.request.id;

    const signed = await signIn(PASSENGER_PHONE, '/api/passenger/auth/verify');
    assert.equal(signed.passenger.phone, PASSENGER_PHONE);
    assert.equal(signed.trips, 1, 'the earlier guest booking must be claimed at sign-in');
    passengerToken = signed.token;
  });

  await check('signed-in passenger cannot book on another number', async () => {
    const result = await book({ driver_id: riderId, kind: 'ride', client_phone: GUEST_PHONE, distance_km: 3 }, passengerToken);
    assert.equal(result.status, 403, `expected phone_not_yours, got ${JSON.stringify(result.json)}`);
    assert.equal(result.json.error, 'phone_not_yours');
  });

  await check('passenger dashboard reads profile, stats and trips', async () => {
    const me = ok(await api('/api/passenger/me', { token: passengerToken }), 200, 'passenger/me');
    assert.equal(me.stats.total, 1);
    assert.equal(me.stats.active, 1);
    assert.deepEqual(me.passenger.places, []);
    const trips = ok(await api('/api/passenger/trips?scope=active', { token: passengerToken }), 200, 'trips/active');
    assert.equal(trips.trips.length, 1);
    assert.equal(trips.trips[0].rider.phone, RIDER_PHONE, 'the trip must carry the rider card');
    assert.equal(trips.trips[0].cancellable, true);
    assert.equal(trips.trips[0].rateable, false);
  });

  await check('driver and passenger sessions cannot be swapped', async () => {
    assert.equal((await api('/api/drivers/me', { token: passengerToken })).status, 401, 'a passenger token must not open the rider API');
    assert.equal((await api('/api/passenger/me', { token: riderToken })).status, 401, 'a rider token must not open the passenger API');
    assert.equal((await api('/api/admin/stats', { token: riderToken })).status, 403, 'a rider token must not open the console');
    assert.equal((await api('/api/passenger/trips')).status, 401, 'the passenger API needs a session');
  });

  await check('rider dashboard sees the incoming request', async () => {
    const list = ok(await api('/api/drivers/me/requests?scope=active', { token: riderToken }), 200, 'me/requests');
    assert.equal(list.requests.length, 1);
    assert.equal(list.requests[0].id, firstTripId);
    assert.equal(list.totals.awaiting, 1);
    assert.equal(list.requests[0].paymentStatus, null, 'an unpaid trip has no payment state');
  });

  await check('accepting a trip makes the rider busy and blocks a second one', async () => {
    const accepted = ok(await api(`/api/requests/${firstTripId}/status`, {
      method: 'PATCH', token: riderToken, body: { status: 'accepted' },
    }), 200, 'accept');
    assert.equal(accepted.request.status, 'accepted');
    assert.equal(accepted.driver.onTrip, true);
    assert.equal(accepted.driver.state, 'with_passenger');
    const busy = await book({ driver_id: riderId, kind: 'ride', distance_km: 2 }, passengerToken);
    assert.equal(busy.status, 409, 'a rider who is carrying someone cannot be booked');
    assert.equal(busy.json.error, 'driver_busy');
    const stats = ok(await api('/api/drivers/me/stats', { token: riderToken }), 200, 'stats');
    assert.equal(stats.totals.running, 1);
    assert.equal(stats.driver.state, 'with_passenger');
  });

  await check('passenger cancels the accepted trip and frees the rider', async () => {
    const cancelled = ok(await api(`/api/passenger/trips/${firstTripId}/cancel`, {
      method: 'POST', token: passengerToken, body: {},
    }), 200, 'passenger cancel');
    assert.equal(cancelled.trip.status, 'cancelled');
    assert.equal(cancelled.trip.cancellable, false);
    const rider = ok(await api('/api/drivers/me', { token: riderToken }), 200, 'driver/me');
    assert.equal(rider.driver.onTrip, false, 'a cancelled trip must release the rider');
  });

  await check('second trip runs to completion and takes the rider off the road', async () => {
    const trip = ok(await book({
      driver_id: riderId, kind: 'delivery', origin: 'Nyarutarama', destination: 'Airport',
      client_name: 'Test Guest', distance_km: 4,
    }, passengerToken), 201, 'signed-in booking').request;
    assert.ok(trip.passengerId, 'a signed-in booking is linked to the passenger');
    ok(await api(`/api/requests/${trip.id}/status`, { method: 'PATCH', token: riderToken, body: { status: 'accepted' } }), 200, 'accept');
    const done = ok(await api(`/api/requests/${trip.id}/status`, {
      method: 'PATCH', token: riderToken, body: { status: 'completed' },
    }), 200, 'complete');
    assert.equal(done.request.status, 'completed');
    assert.equal(done.driver.online, false, 'finishing a trip signs the rider off the live list');
    completedTripId = trip.id;
  });

  await check('passenger rates the finished trip once, with a comment', async () => {
    const rated = ok(await api(`/api/passenger/trips/${completedTripId}/rating`, {
      method: 'POST', token: passengerToken, body: { stars: 5, comment: 'Yageze aho njya vuba.' },
    }), 200, 'rating');
    assert.equal(rated.trip.rating.stars, 5);
    assert.equal(rated.trip.rateable, false);
    const twice = await api(`/api/passenger/trips/${completedTripId}/rating`, {
      method: 'POST', token: passengerToken, body: { stars: 1 },
    });
    assert.equal(twice.status, 409, 'the same trip must not rate twice');
    assert.equal(twice.json.error, 'already_rated');
    const early = await api(`/api/passenger/trips/${firstTripId}/rating`, {
      method: 'POST', token: passengerToken, body: { stars: 4 },
    });
    assert.equal(early.json.error, 'not_completed', 'a cancelled trip is not rateable');
  });

  await check('rider earnings, rating feed and history add up', async () => {
    const stats = ok(await api('/api/drivers/me/stats', { token: riderToken }), 200, 'stats');
    assert.equal(stats.periods.today.trips, 1, 'the completed trip counts in today');
    assert.ok(stats.periods.today.gross_rwf > 0);
    assert.equal(stats.periods.today.payout_rwf, 0, 'nothing is paid out before a payment is confirmed');
    assert.equal(stats.rating.average, 5);
    assert.equal(stats.rating.count, 1);
    assert.equal(stats.rating.withComments, 1);
    assert.equal(stats.rating.distribution[0].stars, 5);
    assert.equal(stats.rating.distribution[0].count, 1);
    assert.equal(stats.unbilled.trips, 1, 'a finished trip with no payment is unbilled');
    assert.equal(stats.can_go_online, true);
    assert.ok(stats.commissionPercent >= 0);
    const feed = ok(await api('/api/drivers/me/ratings', { token: riderToken }), 200, 'ratings');
    assert.equal(feed.ratings.length, 1);
    assert.equal(feed.ratings[0].stars, 5);
    assert.equal(feed.ratings[0].passenger_name, 'Test Guest', 'the rider sees the booking name');
    const history = ok(await api('/api/drivers/me/requests?scope=history', { token: riderToken }), 200, 'history');
    assert.equal(history.requests.length, 2);
    assert.equal(history.totals.completed, 1);
    assert.equal(history.totals.cancelled, 1);
  });

  await check('NDITEGUYE brings the rider back online after a trip', async () => {
    const ready = ok(await api('/api/drivers/me/ready', { method: 'POST', token: riderToken, body: {} }), 200, 'ready');
    assert.equal(ready.driver.online, true);
    assert.equal(ready.driver.onTrip, false);
  });

  await check('passenger saves, lists and deletes places', async () => {
    const home = ok(await api('/api/passenger/places', {
      method: 'POST', token: passengerToken,
      body: { label: 'home', address: 'Kigali Heights Block 5', lat: -1.9441, lng: 30.0731 },
    }), 201, 'places/save');
    assert.equal(home.place.label, 'home');
    const clash = await api('/api/passenger/places', {
      method: 'POST', token: passengerToken, body: { label: 'home', address: 'Somewhere else' },
    });
    assert.equal(clash.status, 409, 'a saved label cannot be reused');
    const work = ok(await api('/api/passenger/places', {
      method: 'POST', token: passengerToken, body: { label: 'work', address: 'Kacyiru' },
    }), 201, 'places/save work');
    const list = ok(await api('/api/passenger/places', { token: passengerToken }), 200, 'places');
    assert.equal(list.places.length, 2);
    assert.equal(list.places.find((row) => row.label === 'home').lat, -1.9441);
    const gone = ok(await api(`/api/passenger/places/${work.place.id}`, { method: 'DELETE', token: passengerToken }), 200, 'places/delete');
    assert.equal(gone.deleted, work.place.id);
    assert.equal((await api(`/api/passenger/places/${work.place.id}`, { method: 'DELETE', token: passengerToken })).status, 404);
  });

  await check('passenger profile edits name and email', async () => {
    const patched = ok(await api('/api/passenger/me', {
      method: 'PATCH', token: passengerToken, body: { name: 'Test Passenger', email: 'test.pass@example.rw' },
    }), 200, 'passenger/me edit');
    assert.equal(patched.passenger.name, 'Test Passenger');
    assert.equal(patched.passenger.email, 'test.pass@example.rw');
    assert.equal((await api('/api/passenger/me', { method: 'PATCH', token: passengerToken, body: {} })).status, 422);
  });

  await check('a trip belongs to its own passenger only', async () => {
    const other = await signIn(GUEST_PHONE, '/api/passenger/auth/verify');
    assert.equal((await api(`/api/passenger/trips/${completedTripId}`, { token: other.token })).status, 403,
      'another passenger must not read this trip');
    const own = ok(await api(`/api/passenger/trips/${completedTripId}`, { token: passengerToken }), 200, 'trip detail');
    assert.equal(own.trip.payment, null);
    assert.equal(own.trip.payable, true, 'a finished trip can still be paid for');
  });

  await check('admin console lists riders, trips and passengers', async () => {
    const riders = ok(await api('/api/admin/riders', { token: adminToken }), 200, 'riders');
    assert.equal(riders.riders.length, 3, 'admin, approved rider and the pending one');
    const rider = riders.riders.find((row) => row.phone === RIDER_PHONE);
    assert.equal(rider.tripsCompleted, 1);
    assert.ok(rider.grossRwf > 0);
    assert.equal(rider.online, true);
    const search = ok(await api(`/api/admin/riders?q=${encodeURIComponent(plateFor('A'))}`, { token: adminToken }), 200, 'riders search');
    assert.equal(search.riders.length, 1, 'a plate search must find exactly one rider');
    const trips = ok(await api('/api/admin/trips?scope=all', { token: adminToken }), 200, 'trips');
    assert.equal(trips.trips.length, 2);
    assert.equal(trips.trips[0].driver.phone, RIDER_PHONE);
    assert.equal(trips.trips[0].rated, true, 'the console sees which trips were rated');
    const passengers = ok(await api('/api/admin/passengers', { token: adminToken }), 200, 'passengers');
    assert.equal(passengers.passengers.length, 2);
    assert.equal(passengers.passengers.find((row) => row.phone === GUEST_PHONE).trips, 0);
    assert.equal(passengers.passengers.find((row) => row.phone === PASSENGER_PHONE).trips, 2);
  });

  await check('admin stats and overview add up', async () => {
    const stats = ok(await api('/api/admin/stats', { token: adminToken }), 200, 'admin/stats');
    assert.equal(stats.drivers.approved, 2);
    assert.equal(stats.drivers.pending, 1);
    assert.equal(stats.requests.total, 2);
    assert.equal(stats.requests.completed, 1);
    assert.equal(stats.requests.cancelled, 1);
    assert.equal(stats.today.trips, 2, 'both bookings were made today in Kigali time');
    assert.equal(stats.passengers.accounts, 2);
    assert.equal(stats.passengers.places, 1);
    assert.equal(stats.passengers.ratings, 1);
    assert.equal(stats.passengers.averageStars, 5);
    assert.equal(stats.payments.collectedRwf, 0);
    const overview = ok(await api('/api/admin/overview', { token: adminToken }), 200, 'overview');
    assert.equal(overview.series.length, 7, 'the chart needs one point per day');
    assert.equal(overview.series[6].trips, 2);
    assert.ok(overview.byKind.some((row) => row.kind === 'delivery'));
    assert.equal(overview.topRiders[0].trips, 1);
    assert.equal(overview.topRiders[0].area.code, 'kigali-city-gasabo-remera-nyarutarama',
      'the overview names the division the rider picked, not a typed string');
    assert.ok(overview.byZone.length >= 1);
    assert.equal(overview.webhooks.received, 0);
    const ledger = ok(await api('/api/admin/payments', { token: adminToken }), 200, 'payments');
    assert.deepEqual(ledger.payments, []);
    assert.equal(ledger.totals.collected_rwf, 0);
  });

  await check('admin force-cancels a trip the rider sat on', async () => {
    const trip = ok(await book({ driver_id: riderId, kind: 'ride', origin: 'Kacyiru', destination: 'Kimihurura', distance_km: 2 },
      passengerToken), 201, 'booking').request;
    ok(await api(`/api/requests/${trip.id}/status`, { method: 'PATCH', token: riderToken, body: { status: 'seen' } }), 200, 'seen');
    const cancelled = ok(await api(`/api/admin/trips/${trip.id}/cancel`, {
      method: 'POST', token: adminToken, body: {},
    }), 200, 'admin cancel');
    assert.equal(cancelled.trip.status, 'cancelled');
    const again = await api(`/api/admin/trips/${trip.id}/cancel`, { method: 'POST', token: adminToken, body: {} });
    assert.equal(again.status, 409, 'a finished trip cannot be cancelled twice');
  });

  await check('admin suspends a rider, cancelling their open trips', async () => {
    const application = ok(await api('/api/admin/applications?status=pending', { token: adminToken }), 200, 'applications').applications[0];
    ok(await api(`/api/admin/applications/${application.id}/decision`, {
      method: 'POST', token: adminToken, body: { action: 'approve', zone: 'Remera', services: 'ride', capacity: 1 },
    }), 200, 'approve second rider');
    const secondToken = (await signIn(SECOND_RIDER_PHONE)).token;
    ok(await api('/api/drivers/me/ready', { method: 'POST', token: secondToken, body: {} }), 200, 'second rider online');
    const trip = ok(await book({
      driver_id: application.id, kind: 'ride', origin: 'Remera', destination: 'Kigali Heights', distance_km: 3,
    }, passengerToken), 201, 'booking to second rider').request;
    ok(await api(`/api/requests/${trip.id}/status`, { method: 'PATCH', token: secondToken, body: { status: 'accepted' } }), 200, 'accept');

    const suspended = ok(await api(`/api/admin/riders/${application.id}/action`, {
      method: 'POST', token: adminToken, body: { action: 'suspend', reason: 'No plate inspection' },
    }), 200, 'suspend');
    assert.equal(suspended.rider.status, 'rejected');
    assert.equal(suspended.rider.online, false);
    assert.equal(suspended.cancelledTrips, 1, 'open trips must be cancelled with the rider');
    const blocked = await api('/api/drivers/me/requests', { token: secondToken });
    assert.equal(blocked.status, 403, 'a suspended rider loses the dashboard');
    const reinstated = ok(await api(`/api/admin/riders/${application.id}/action`, {
      method: 'POST', token: adminToken, body: { action: 'reinstate' },
    }), 200, 'reinstate');
    assert.equal(reinstated.rider.status, 'approved');
    assert.equal(reinstated.rider.reason, null);
    const selfGuard = await api(`/api/admin/riders/${adminId}/action`, {
      method: 'POST', token: adminToken, body: { action: 'suspend' },
    });
    assert.equal(selfGuard.status, 409, 'an admin account cannot be suspended');
    const forced = ok(await api(`/api/admin/riders/${application.id}/action`, {
      method: 'POST', token: adminToken, body: { action: 'offline' },
    }), 200, 'force offline');
    assert.equal(forced.rider.online, false);
    assert.equal(forced.rider.onTrip, false);
  });

  await check('an unpaid trip is closed as failed, not left pending', async () => {
    const result = await api(`/api/requests/${completedTripId}/payments`, {
      method: 'POST', body: { provider: 'paystack', email: 'test.pass@example.rw' },
    });
    assert.equal(result.status, 503, `expected paystack_not_configured, got ${JSON.stringify(result.json)}`);
    assert.equal(result.json.error, 'paystack_not_configured');
    const ledger = ok(await api('/api/admin/payments', { token: adminToken }), 200, 'payments');
    assert.equal(ledger.payments.length, 1);
    assert.equal(ledger.payments[0].status, 'failed', 'a payment the provider refused is recorded as failed');
    assert.equal(ledger.totals.open_rwf, 0, 'nothing is left open');
  });

  console.log(`\n[seremoto] dashboards: ${passed} passed, ${failures.length} failed`);
  if (failures.length) failures.forEach((line) => console.log(`  - ${line}`));
} catch (error) {
  console.error('[seremoto] dashboards suite crashed:', error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  child.kill();
  await wait(400);
  await s3.stop();
  await pg.stop();
}

if (failures.length) process.exitCode = 1;
process.exit(process.exitCode || 0);
