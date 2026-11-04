# SERE Moto

Transport marketplace for Kigali moto riders and car drivers. Riders sign up with their national ID, TIN
and plate — the digit laws are enforced and, once the RRA / NIDA credentials are in place, each number is
confirmed against the register that actually holds it — then a SERE Moto admin approves that application, and
only then does the rider appear in search and start receiving requests. The applicant also uploads photos of
their national ID, driving licence and plate to a private S3 bucket, which the approving admin opens with
short-lived signed links. Clients search online drivers, send a
request that hands off to the driver's WhatsApp, and pay the fare through MTN MoMo or a card via Paystack. The
platform keeps a commission from each paid trip and the driver gets the rest.

Motorcycle fares are not negotiated: the server prices every moto trip on the RURA table, and distances are
measured on real roads through OpenStreetMap, so neither the client nor the rider can move the number. A
rider's phone posts their own GPS fix while the app is open, which is what makes "who is near me and free"
a live answer instead of a zone guess. Every area in the app comes from Rwanda's own register of 17,437
divisions — Intara, Akarere, Umurenge, Akagari and Umudugudu. The booking page asks for them one question at
a time and the dashboards use cascading dropdowns, so a search for Gasabo and a fix posted in neighbouring
Kimisagara reach the same rider.

Real backend, not a prototype: Express + Neon Postgres (`pg`), passwordless OTP login, RSA-verified
Google sign-in, admin-reviewed applications, rider documents in an S3-compatible bucket, and live provider
calls. Every business rule is enforced server-side, so the API rejects bad data even if the UI is bypassed.
There are no passwords to leak and no mocked responses anywhere in the code.

## Requirements

* Node.js 22.5 or newer (24 is what it is developed and deployed on). The only database is a Postgres
  server — a Neon `postgresql://` URL in `DATABASE_URL`. There is no bundled/local-file fallback and no
  Prisma/`generate` step.
* An S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO) for rider documents. Optional: with
  no `S3_*` keys the app still runs and the upload endpoints answer `503 storage_not_configured`.
* Nothing else. Runtime dependencies are Express, dotenv, `pg`, and the AWS SDK S3 client + presigner.

## How signing in works

There is no password. A driver proves a phone number, then proves identity through a SERE Moto admin:

1. **Phone → OTP.** `POST /api/auth/otp/send` first screens the digits with the phone provider (see
   *Rider credential checks*), so a number that cannot exist is refused with `422 phone_invalid` before any
   SMS credit is spent; then it stores a hash of a 6-digit code with a TTL, an attempt cap, a
   resend cooldown and an hourly cap. `POST /api/auth/otp/verify` returns a 15-minute `verify_token` bound
   to that exact number — proof the number is in the user's hand, nothing more.
2. **Known number** → the session token is returned immediately with the driver's `status`.
   **Unknown number** → `{ status: "new", verifyToken }` and the UI offers `/signup`.
3. **Sign up** (`POST /api/auth/signup`) requires that `verify_token` plus names, ID number, TIN and plate.
   The digit laws in `src/validate.js` are hard rules — a phone is exactly **10 digits** (`07` + 8 others), a
   national ID exactly **16**, a TIN exactly **9** — and `GET /api/config` publishes the same numbers, so the
   form can never drift away from the API. Anything else is refused before a row is written: `invalid_phone`,
   `invalid_id_number`, `invalid_tin_number`. An accepted application is written with `status = 'pending'`
   and the applicant is told to wait — nothing is usable yet.
4. **The registers answer for themselves.** When RRA / NIDA / phone-check credentials are configured, the
   application also stores what each service actually said — `pass`, `fail`, `unavailable` or `unchecked`,
   visible as three pills on the admin queue. A TIN or ID the register does not recognise is a hard `422`, not
   a warning; a register that could not be reached is never recorded as a pass. See
   *Rider credential checks* below.
5. **Admin approval** (`/admin`, `POST /api/admin/applications/:id/decision`). An admin checks the ID, TIN
   and plate, then approves or rejects with a reason. Approval can also fill in zone, services and
   price-per-km inline if the rider has not set them yet. A single pill can be re-checked with
   `POST /api/admin/applications/:id/verify` once the credentials are in place.
6. **Pending and rejected accounts hold a token but get nothing.** The API answers `403 account_pending` on
   the driver dashboard, `409 driver_unavailable` if a client tries to book them, and they never appear in
   `GET /api/drivers`. A rejected number verifies its OTP and gets back `{ status: "rejected", reason }`
   with no session token at all, so the login page can show the admin's reason. Rejected accounts cannot be
   approved silently — an admin decision on them returns `409 already_reviewed`.
7. **Google** works the same way: the ID token from Google Identity Services is verified against Google's
   JWKS (RS256 signature plus `iss`/`aud`/`exp`) server-side, and the verified e-mail's address is looked
   up as a Rwandan number. Google never bypasses the approval gate — a first-time Google user still gets
   `status: "new"` and goes through signup.

Admin access is not a checkbox in the database. The first time the number in `ADMIN_PHONE` verifies an OTP,
it is flagged `is_admin = 1`, which unlocks `/admin` and the decision endpoints. Everyone else gets
`403 admin_only`.

## Fares and distances

**RURA's table is the price, server-side.** Motorcycle trips are priced by `src/fares.js` from RURA Board
Decision `03/BD/RD-TRP/2021` as adjusted in August 2022:

| Band | Charge |
| --- | --- |
| First 2 km | 400 RWF (the minimum fare) |
| 2 – 40 km | 117 RWF/km |
| Beyond 40 km | 187 RWF/km |
| Waiting | first 10 minutes free, then 21 RWF/min |
| Rounding | nearest 10 RWF |

No public Rwanda fare API exists — RURA publishes these numbers as PDFs — so they live in `.env` and the
server applies them. The rule is binding, not advisory:

* `price_per_km` is ignored for a `moto`. An admin can approve a motorcycle without ever entering a rate,
  and a rider going online is only asked for zone and services (`409 profile_incomplete` names `price_per_km`
  for cars alone).
* `POST /api/requests` recomputes the fare from the distance itself; a fare sent by the client is never
  trusted. The response returns `fare_rwf`, `fare_components` and `fare_basis`.
* Cars keep their own per-kilometre rate and are labelled `driver_rate` everywhere, including the driver
  card and the booking sheet, so a regulated price is never confused with a negotiated one.
* `/api/config` publishes the live table (`fare.motorcycle`) and the rule name, so the UI quotes the same
  numbers the server charges.

**Distance comes from OpenStreetMap**, not a straight line. `GET /api/fare` (and `POST /api/requests` when no
`distance_km` is given) geocodes `from`/`to` with Nominatim and routes them with OSRM:

* Both calls are key-free and rate-limit friendly: geocodes run sequentially at Nominatim's 1 request/second,
  a real `User-Agent` is sent (`OSM_USER_AGENT`), and results are cached in the `places` and `routes` tables,
  so a repeated Kigali journey is served from Postgres in about a second instead of leaving the process.
* Ambiguous names are anchored: a client GPS fix (`near`) is used as the search centre, otherwise Kigali, and
  a hit more than 25 km from that anchor is rejected — that is what stops "Remera" resolving to the town in
  Musanze and pricing a 5 km trip at 99 km. A miss retries once with `, Kigali` appended.
* Every response carries `source`: `osrm`, `cache` or `estimated` (haversine × 1.35 when the network is down).
  A place that cannot be resolved returns `422 place_not_found` and the booking form falls back to a manual
  `distance_km`.

Attribution: distances and place names are © OpenStreetMap contributors (OSRM / Nominatim).

**Live rider proximity.** A rider's browser posts its own position to `POST /api/drivers/me/location` as long
as the app is open (a web page cannot track in the background). `GET /api/drivers?near=<lat,lng>&max_km=25`
returns approved drivers with `distanceKm`, `locAgeSeconds`, `live` and `state`:

* `live` is only true inside `LIVE_LOCATION_SECONDS` (default 180). A stale fix is demoted below fresh ones and
  loses its `LIVE` badge, so "near me" never advertises a position from ten minutes ago.
* `state` is `available`, `with_passenger` or `offline`. Accepting a request sets `on_trip`; completing one
  clears the trip **and** takes the rider offline, so the next trip needs a deliberate `Nditeguye` (I'm ready).
  A rider already carrying a passenger cannot be accepted again — `409 driver_busy` — and the client card shows
  *Has a passenger* with the Drive-me button disabled.
* `available=1` filters to riders who are online and free. On the booking page the passenger asks for it with
  the *Bari online gusa* / *Online riders only* switch inside the Menu; the number beside the results heading is
  the same set, counted from the rows already on screen.
* `division=<code>` filters by Rwanda's own administrative map instead of a typed zone name — see below.

## Rwanda divisions

The app never asks a rider or a passenger to type an area. It walks the official register:

| Level | Kinyarwanda | Rows |
| --- | --- | --- |
| Province | Intara | 5 |
| District | Akarere | 30 |
| Sector | Umurenge | 416 |
| Cell | Akagari | 2,149 |
| Village | Umudugudu | 14,837 |

**Where the data comes from.** `scripts/build-locations.mjs` pulls all five levels from the IREME locations
API (`https://iremeairwanda-1.onrender.com/api/locations`, the register this project's own division data lives
in), rebuilds each code from its parent (`kigali-city-gasabo-remera-nyarutarama`), adds the official
Kinyarwanda province names, and refuses to write the file if any level's count is not the published one — a
short page is a bug, not a smaller Rwanda. The result is `data/locations.json` (17,437 rows), which the server
inserts into the `locations` table the first time a database opens without it. Nothing in the app ever writes
a division: it is law, not user input, so the API is read-only and the tree needs no admin screen.

**Map points come from OpenStreetMap.** The register carries names and codes but no coordinates, and the live
tracker needs to know which part of the country a GPS fix falls in. `scripts/fetch-division-coords.mjs` asks
Overpass for the level-4 (Intara), level-6 (Akarere) and level-8 (Umurenge) boundary relations, takes each
relation's centroid, and merges it into the seed with `--coords`. A level-8 relation carries no pointer to its
district, so sectors are matched by name — and Remera, Karama and Muganza are names shared by sectors in
different districts, so the pair whose district centre sits closest wins. Cells and villages are not mapped as
boundaries on OSM and stay unpointed. Attribution: © OpenStreetMap contributors (ODbL), same as the distances
and place names above.

**A fix is answered at the deepest level it can honestly prove.** `GET /api/locations/point?lat=&lng=` returns
the nearest sector centroid, or the district, or the province — plus `distance_to_centre_km` and
`approximate: true`. A centroid is not a boundary, so the UI must say *hafi ya* / *around*, never *in*: the
rider footer reads "Uhagaze hafi ya Kimisagara" and the booking card "around Kimisagara". `503
divisions_unmapped` covers a build with no coordinates at all.

**One rule for finding riders.** Both `GET /api/drivers?division=` and `GET /api/admin/riders?division=` take a
code at *any* level and answer with the riders who work in it **or** whose last fix fell in it — so a Gasabo
rider who was last seen in neighbouring Kimisagara shows up when a passenger asks for Kimisagara, and a
province code covers every district under it. The response echoes `division` with the filtered `riders` count
so a page can say how many it found.

**Every row carries two divisions.** A rider record answers `area` (where they said they work, picked from the
dropdowns) and `around` (where their last fix landed, only while `live`), each as `{code, level, levelKey,
name, label, path}` in the language asked for — `label` is the one-line "Umujyi wa Kigali, Gasabo, Remera,
Nyarutarama", `path` the chain above the leaf. `zone` still travels along as the free-text label the older
screens show, rebuilt from the picked division.

**The dashboards share one dropdown component.** `public/assets/divisions.js` exposes `SERE_DIVISIONS` —
`mount(host, {depth, onChange})`, `value()`, `set(code)`, `repaint()`, `point(lat, lng)`, `list(parentCode,
levelKey)` and a static `setLang()`. A mount builds one `<select>` per level and asks `/api/locations?parent=`
for the next row only after the pick above it changes, so the browser never holds 14,837 names. Depth decides
the reach: 3 (province → district → sector) for the admin console, 4 for a rider's own work area. Dashboards
repaint their panel, so a host that leaves the document is dropped from the component's registry — a language
switch only refetches what is still on screen.

**The booking page asks instead of offering dropdowns.** `public/assets/interview.js` exposes `SERE_INTERVIEW` —
`levels`, `mount(host, {api, onChange})`, `setLang()`, `getLang()` — and drives the passenger through the same
register one question at a time: *Intara yawe?* → *Akarere kawe?* → *Umurenge wawe?* → *Akagari kawe?* →
*Umudugudu wawe?*. Each screen is a plain list — one row per place `list()` returns under the previous answer,
separated by hairlines, never boxed buttons — and each row is a `<label class="ask-opt">` holding a real
`<input type="radio" class="ask-dot">` plus the UPPERCASE place name, so any tap on the row answers it, the
picked circle fills for a beat, and the next question opens. Cell and village offer *Komeza* / *Continue* as an
`.ask-act` row — an action, not a place — because a search matches at any level and a sector answer is already a
complete one; an uppercase *Subira inyuma* / *Back* link sits under the list.
`value()` is the deepest answer picked, `done()` is true only when the ladder has ended, and `onChange`
fires on every step — the page searches as the passenger answers, but the
*Noneho ushaka kujya hehe?* destination box stays hidden until `done()`, and the first time it opens a
*Woow! Twamaze kumenya aho uri.* popup (`#congrats`) sits over it until tapped away. Its twelve `ask.*` strings
are owned by the file and checked by `scripts/check-i18n.js` like every other dictionary; the page's RW/EN
toggle calls `setLang()`.

**Language is a parameter, not a guess.** Division names are built by the server, and
`src/validate.js:language()` answers English when `lang` is missing. `SERE.api()` therefore appends
`lang=<current>` to every call that does not already carry one, and each dashboard reloads its panel on the
RW/EN toggle — otherwise a Kinyarwanda page would show English place names.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/locations/levels` | The five levels with their row counts and the total |
| GET | `/api/locations?parent=&level=&q=&limit=` | Children of one division, or everything at one level |
| GET | `/api/locations/search?q=&level=` | One box matching across all five levels |
| GET | `/api/locations/chain?code=` | The full path a division hangs off |
| GET | `/api/locations/point?lat=&lng=` | Deepest honest answer for a GPS fix |

## Run it locally

```bash
cd seremoto
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste the output into JWT_SECRET
```

Then set these three in `.env`:

```
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxxx-pooler.eu-central-1.aws.neon.tech/DBNAME?sslmode=require
JWT_SECRET=<the 64-char hex you just generated>
ADMIN_PHONE=0788210345
```

`DATABASE_URL` is the connection string Neon gives you under **Connect** — copy the **pooled** one and keep
`?sslmode=require` on the end. The server refuses to boot without it rather than pretending to hold data it
cannot reach. See *Database (Neon)* below for creating the project and the schema.

```bash
npm run seed
npm start
```

Open http://127.0.0.1:3000 — the UI is bilingual, Kinyarwanda by default with an EN toggle. Login lives at
`/login`, signup at `/signup`, the admin console at `/admin`.

`npm run seed` creates no sample traffic. It only guarantees that the `ADMIN_PHONE` account exists and is
`approved` + admin, so `/admin` is reachable on a fresh database. Every rider you see afterwards signed up
through `/signup` and was approved in the console.

Payments are deliberately unconfigured in a fresh `.env`. With `PAYSTACK_SECRET_KEY` or the MoMo vars empty,
the API answers `503 paystack_not_configured` / `503 momo_not_configured` and the UI shows that in the
visitor's language. Nothing is faked: a payment either reaches the real provider or fails.

## Configuration

`.env` values that work on a laptop:

```
PORT=3000
HOST=127.0.0.1
PUBLIC_URL=http://127.0.0.1:3000
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxxx-pooler.eu-central-1.aws.neon.tech/DBNAME?sslmode=require
DATABASE_SSL=
DATABASE_POOL_MAX=10
JWT_SECRET=<the 64-char hex you generated>
SESSION_HOURS=720
PLATFORM_COMMISSION_PERCENT=5
ADMIN_PHONE=0788210345
OTP_ECHO=1                        # laptop only: the code comes back in the API response — never set in production

# Rider documents (ID, licence, plate) — any S3-compatible bucket. Leave empty to disable uploads.
S3_ENDPOINT=
S3_REGION=us-east-1
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=0
S3_SIGNED_URL_TTL_SECONDS=300
S3_MAX_UPLOAD_MB=8

# RURA moto fare table — leave as is unless RURA issues a new decision.
FARE_MOTO_FIRST_KM=2
FARE_MOTO_MIN_RWF=400
FARE_MOTO_MID_BAND_KM=40
FARE_MOTO_RATE_RWF=117
FARE_MOTO_LONG_RATE_RWF=187
FARE_FREE_WAIT_MIN=10
FARE_WAIT_RWF_PER_MIN=21

# OpenStreetMap measurement and live proximity.
OSRM_BASE_URL=https://router.project-osrm.org
NOMINATIM_BASE_URL=https://nominatim.openstreetmap.org
OSM_USER_AGENT=SEREMoto/1.0 (support@sere.moto)
OSM_TIMEOUT_MS=8000
LIVE_LOCATION_SECONDS=180
```

`OSM_USER_AGENT` is not cosmetic: Nominatim's usage policy asks for a contact that identifies the app, and a
generic agent gets the shared instance to throttle you. Set `LIVE_LOCATION_SECONDS` higher only if riders
keep the app open between fixes — it is the age at which a position stops being advertised as live.

Leave `PAYSTACK_SECRET_KEY`, the `MOMO_*` values, `SMS_PROVIDER_KEY`, `GOOGLE_CLIENT_ID`, every
`RRA_*` / `ID_*` / `NUMVERIFY_*` / `PHONE_CHECK_*` value and the `S3_*` block empty until you have real credentials — a
half-filled block is worse than an empty one because requests then fail with network errors instead of a
clear "not configured". At boot the server prints every gap it found (`missing configuration:
PAYSTACK_SECRET_KEY, RRA_BASE_URL …`) together with the vars the *chosen* SMS provider needs, so you know
which features will answer 503.

### Database (Neon)

1. Create a project at console.neon.tech (any region near Kigali; `eu-central-1` is the shortest hop) and a
   database, e.g. `seremoto`.
2. **Connect** → copy the **pooled** connection string and set it as `DATABASE_URL`. The pooled endpoint
   (`…-pooler.…`) matters on serverless hosts: a burst of requests can otherwise exhaust Neon's direct
   connection limit.
3. Keep `?sslmode=require`. The `pg` driver uses it automatically; `DATABASE_SSL` is only needed to force
   `no-verify` against a self-signed proxy. `DATABASE_POOL_MAX` (default 10) is the per-process pool size.
4. The schema creates itself: `src/db.js` runs `src/schema.js` on boot, and the statement is idempotent
   (`CREATE TABLE IF NOT EXISTS`, named constraints), so the first boot on an empty database builds all
   fifteen tables and later boots change nothing.
5. `npm run seed:locations` loads the 17,437-row division tree from `data/locations.json`, and `npm run seed`
   guarantees the `ADMIN_PHONE` admin account. Both are safe to re-run.

There is no MySQL/SQLite mode and no file to back up — Neon keeps its own point-in-time history, which is
what "Restore" in the console uses.

### Rider documents (S3)

An approved application is only as good as the papers behind it, so the rider profile carries three
photos — `national_id`, `driving_licence` and `plate` — and the console shows them next to the approve
button. The browser never holds a bucket credential and never learns the object key policy:

1. `POST /api/drivers/me/documents/:kind/upload-url` signs a **PUT** for
   `riders/<driverId>/<kind>` with the declared content type and a TTL (`S3_SIGNED_URL_TTL_SECONDS`,
   default 300 s), and records the row as `pending` (replacing an earlier photo of the same kind).
2. The rider's browser uploads the file straight to the bucket with that URL — the bytes never pass through
   this process, so an 8 MB photo does not tie up a request slot.
3. `POST /api/drivers/me/documents/:kind/complete` HEADs the object, checks the type and size, and only
   then marks the row `uploaded` with the real byte count.
4. `GET /api/admin/riders/:id/documents` returns signed **GET** links, valid for the same TTL, so an admin
   can open each photo during review. `GET /api/drivers/me/documents` does the same for the rider's own.

Accepted types are JPEG, PNG and WebP; `S3_MAX_UPLOAD_MB` (default 8) caps the size. Any S3-compatible
service works — set `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, and add
`S3_ENDPOINT` plus `S3_FORCE_PATH_STYLE=1` for R2 / MinIO / Backblaze. Keep the bucket **private**: the app
only ever reads through signed URLs, so a public bucket would leak every rider's ID. The IAM user needs
`s3:PutObject` and `s3:GetObject` on `riders/*` and nothing else — S3 authorises the `HeadObject` check with
`s3:GetObject`, so no extra permission is required.
Because the browser PUTs straight to the bucket, the bucket also needs a CORS rule for your site's origin —
without it the upload fails in the browser with a network error before a byte is sent:

```json
[{ "AllowedOrigins": ["https://your-domain.rw", "http://127.0.0.1:3000"],
   "AllowedMethods": ["PUT", "GET"], "AllowedHeaders": ["*"],
   "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3000 }]
```

`GET /api/health` reports `storage.configured` so a deploy can be checked without opening the console.

### Login OTP (SMS)

With no provider key set the server runs in **dev mode**: it prints the code to its own console and sends
nothing. The code is put in the `/api/auth/otp/send` response only when you also set `OTP_ECHO=1`, which is
what `test/smoke.js` needs to sign in. Never set `OTP_ECHO` in public: anyone who can read that response logs
in as anyone. At boot the server lists `OTP_ECHO=1` as a problem when it is on, so a leftover dev flag shows
up in the startup log — and no customer can log in at all until a provider is wired up.

Pick the adapter with `SMS_PROVIDER`; each one needs its own pair of vars, and `SMS_PROVIDER_KEY` is what
switches dev mode off:

| `SMS_PROVIDER` | Required | Notes |
| --- | --- | --- |
| `generic` (default when unset) | `SMS_PROVIDER_URL` + `SMS_PROVIDER_KEY` | POST JSON `{to, from, message}` with `Authorization: Bearer <key>` — any aggregator that speaks that shape. |
| `africastalking` (what `.env.example` picks) | `SMS_USERNAME` + `SMS_PROVIDER_KEY` | dashboard.africastalking.com → Settings → API keys. Posts form-encoded to `https://api.africastalking.com/version1/messaging` unless `SMS_PROVIDER_URL` overrides it. |
| `twilio` | `SMS_TWILIO_ACCOUNT_SID` (or `SMS_USERNAME`) + `SMS_PROVIDER_KEY` | The auth token, not the API key. `SMS_PROVIDER_URL` overrides the REST endpoint for a proxy. |

```
SMS_SENDER_ID=SEREMOTO
SMS_TIMEOUT_MS=10000
OTP_TTL_SECONDS=300
OTP_MAX_ATTEMPTS=3
OTP_RESEND_SECONDS=30
OTP_MAX_PER_HOUR=8
```

An HTTP 200 is not proof of delivery — Africa's Talking and Twilio both return per-recipient or per-message
status inside a 2xx body — so the adapter reads that status and only calls the message sent when the provider
says `success`/`sent`/`queued`/`accepted`/`delivered`. Anything else returns `502 sms_send_failed` with the
provider's own words in the message, and the OTP is never stored as delivered. The provider's message id is
saved on the challenge (`otp_challenges.provider`, `otp_challenges.sms_ref`) so a "I never got the code"
dispute can be opened with something the provider recognises. The number is stored in local `07…` format and
dialled as `+250…`.

### Rider credential checks (RRA TIN, NIDA ID, live phone)

Three registers can answer questions this server must not guess at: **RRA** for the 9-digit TIN, **NIDA** (or
peleza.com, or any ID contract you are handed) for the 16-digit national ID, and **numverify** (or an
HLR-style service) for the phone number. `src/kyc.js` holds one adapter per register; `src/routes/kyc.js`
exposes them to the signup page. **The browser never talks to a register and never sees a credential** — it
posts to this server, which holds the keys, caches the verdict and answers in one shape.

```
# RRA taxpayer register
RRA_BASE_URL=https://<host-from-your-rra-contract>
RRA_TIN_PATH=/customers/selectCustomer
RRA_TIN_STYLE=query            # query → GET ?tin=…, json → POST {"tin":"…"}
RRA_TIN_FIELD=tin              # name of the parameter the register expects
RRA_API_KEY=                   # Bearer token — or use username/password below
RRA_USERNAME=
RRA_PASSWORD=
RRA_VALID_FIELD=               # pin the key that carries the verdict if "0" is ambiguous there
RRA_NAME_FIELD=                # pin the key that carries the taxpayer name
RRA_TIMEOUT_MS=10000

# National ID register (NIDA, peleza.com, …)
ID_PROVIDER=nida               # label stored on the check; any value works
ID_CHECK_URL=https://<endpoint>
ID_CHECK_KEY=                  # Bearer token — or ID_USERNAME + ID_PASSWORD (Basic)
ID_USERNAME=
ID_PASSWORD=
ID_MATCH_FIELD=
ID_NAME_FIELD=
ID_TIMEOUT_MS=10000

# Phone number check — numverify (apilayer.com) is the first-choice provider
NUMVERIFY_ACCESS_KEY=          # one key from the apilayer dashboard; nothing else is needed
NUMVERIFY_BASE_URL=https://api.apilayer.com/numverify   # legacy free keys: http://apilayer.net/api
NUMVERIFY_TIMEOUT_MS=10000

# …or any live-number / HLR endpoint you are handed (used only when NUMVERIFY_ACCESS_KEY is empty)
PHONE_CHECK_URL=https://<endpoint>
PHONE_CHECK_KEY=
PHONE_CHECK_TIMEOUT_MS=10000

KYC_STRICT=                    # 1 = refuse an application whose registers could not be reached
```

Neither register has a self-serve sandbox you can guess a URL for: the base URL, the auth mode and the field
that carries the verdict come from the contract you are signed up under. That is why all of it is env-driven
rather than hard-coded, and why an adapter that gets an answer it cannot read says so instead of guessing:
it returns `502 tin_check_unavailable` naming the keys the body actually contained and tells you to pin
`RRA_VALID_FIELD` / `RRA_NAME_FIELD` (or `ID_MATCH_FIELD` / `ID_NAME_FIELD`). A bare `0`/`1` is only trusted in
a pinned field, because "0" means success in some government dialects and failure in others.

**numverify is the one register with a self-serve key**, so it is wired as a first-class provider rather than a
generic contract: `GET {base}/validate?access_key=…&number=+25078xxxxxxx` returns `{valid, country_code,
carrier, line_type}` and nothing else is configured. `POST /api/auth/otp/send` screens the digits with it
*before* an SMS goes out, so a number that cannot exist never spends aggregator credit — `422 phone_invalid`.
What it proves is the numbering plan, not a live handset: the verdict is stored as `source = numverify` with
the carrier and line type beside it, and the SMS code stays the only proof that somebody owns the number. A
`{"success":false,"errors":{…}}` body (wrong key, spent quota, 401/500) is recorded as
`phone_check_unavailable` and the code still goes out — an outage on our side must never be shown to a
rider as "your number is wrong" — unless `KYC_STRICT=1`. The verdict is cached for 24 hours (30 minutes when
it is a fail) in `phone_checks`, so the same digits are looked up once, not once per code.

With **no** `RRA_*`/`ID_*`/`NUMVERIFY_ACCESS_KEY`/`PHONE_CHECK_*` keys the app still ships: the three digit laws
are enforced in `src/validate.js`, every credential column is recorded as `unchecked`, and
`POST /api/verify-tin` answers `503 tin_check_unavailable`. Nothing is ever displayed or stored as a pass that
no register confirmed.

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| POST | `/api/verify-tin` | `verify_token`, `tin_number`, optional `force` | `200 {valid, taxpayer, source: rra\|cache}`; `200 {valid:false}` when RRA simply has no such taxpayer |
| POST | `/api/verify-id` | `verify_token`, `id_number`, optional `names`, `force` | `200 {exists, match, source}` — the register's own spelling of the name is **never** echoed, or any 16-digit number could be read back one match at a time |
| POST | `/api/admin/applications/:id/verify` | `check: tin\|id\|phone` | Re-runs one check for that applicant and stores `pass`/`fail` |

Both public lookups are fenced behind the `verify_token` a phone just earned from a real SMS code
(`400 invalid_verify_token` without it) and each phone gets 12 lookups an hour (`429 kyc_rate_limited`), so a
script cannot drive RRA or NIDA through SERE Moto. Verdicts are cached in the database — a pass for 24 hours,
a fail for 30 minutes, so a register outage does not become 200 calls per applicant. `force: true` ignores the
cache; the admin re-check button uses it.

Signup stores four honest states per applicant (`tin_status`, `id_status`, `phone_status`, `kyc_at`):

* `pass` — the register confirmed it.
* `fail` — the register answered and the value was wrong (`tin_not_found`, `id_not_found`,
  `id_name_mismatch`, `phone_not_live`). This blocks the application with a `422`; it is not an outage.
* `unavailable` — the service is configured but did not answer. The application is still filed so a Kigali
  RRA outage cannot stop riders signing up; the pill stays in its neutral *waiting* state for the admin to
  re-check.
* `unchecked` — no credentials for that register, so nobody looked.

Set `KYC_STRICT=1` when the contracts are live and you want the opposite rule: an application is refused with
`503 kyc_unreachable` unless all three registers answered, and any check still `unchecked` fails the signup
too. `/signup` shows a live verdict line per field once the phone is verified; `/admin` shows the three pills
plus the evidence the register gave (taxpayer name, matched name, operator).

### Google sign-in

1. Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client ID → Web
   application**.
2. Add every origin that serves this app to **Authorized JavaScript origins** —
   `http://127.0.0.1:3000` for the laptop and `https://your-domain.rw` for production.
3. Paste the client ID (it ends in `.apps.googleusercontent.com`) into `GOOGLE_CLIENT_ID=`.

With the var empty, `/api/config` reports `googleClientId: null`, the button stays hidden, and a direct
`POST /api/auth/google` fails closed with `503 google_not_configured`. The server fetches Google's public
keys from `GOOGLE_CERTS_URL` (cached 10 minutes) and verifies the token's RS256 signature itself — an
unsigned or wrong-audience token is rejected with `401 google_token_invalid`.

### Paystack (cards)

1. paystack.com Dashboard → Settings → API Keys.
2. Copy the **Secret Key**. Use `sk_test_...` while testing and `sk_live_...` in production:
   `PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
3. Developers → Webhooks → URL `https://your-domain.rw/api/webhooks/paystack`, event `charge.success`
   (add `charge.failed` and `charge.refund` to mark those payments `failed`/`refunded` — the endpoint accepts
   any `charge.*` event and ignores everything else). Paystack signs each delivery with your secret key; the
   server re-computes the HMAC-SHA512 and rejects a mismatch with `401`.
4. Amounts are sent in minor units (RWF × 100) with currency `RWF`, and verified with
   `GET /transaction/verify/:reference` before a payment is marked paid — the webhook alone is trusted only
   after that verification.

### MTN MoMo Collections (Mobile Money)

MoMo credentials come from the MTN developer portal (mtn.co.rw / MOMAPI); the API host is issued with
your approved app and is not guessable, so there is no usable default in this repository.

1. Create an app under **API Products → Mobile Money API (Collections)** and note `USER_ID` (the API user),
   `PRIMARY_KEY` (subscription/service key) and `API_KEY` (secret).
2. Subscribe to the sandbox or production endpoint and copy the base URL it gives you, including the path.
3. Fill in:

```
MOMO_BASE_URL=https://<host-from-mtn>/api/v3
MOMO_USER_ID=<uuid>
MOMO_SUBSCRIPTION_KEY=<service key>
MOMO_PRIMARY_KEY=<primary key>
MOMO_API_KEY=<secret key>
MOMO_CALLBACK_BASE=https://your-domain.rw
```

4. Register the MoMo webhook to `MOMO_CALLBACK_BASE/api/webhooks/mtn-momo`. Deliveries are checked with the
   `x-checksum` MD5 of the body (with the subscription key, which variant your tenant uses is configurable
   in `src/payments/mtnMomo.js`); unknown or duplicate `externalId` values are recorded and ignored.

## Testing

```bash
npm test                                       # seeds + boots its own server on a scratch database
npm run test:dashboards                        # rider / passenger / admin contracts, same idea
npm run test:i18n                              # Kinyarwanda ↔ English key parity
```

Both API suites boot their own server on an ephemeral port against a throwaway Postgres instance, then shut
it down and discard it — so `npm test` can approve a rider, complete and rate trips, or suspend an account
without ever touching the Neon database in `.env`. The scratch database is a real Postgres (`@electric-sql/pglite`
behind a TCP socket), which is why the suites catch Postgres-only mistakes such as an out-of-order foreign
key or a camelCase alias folding to lowercase; no credentials and no network are involved. Set
`TEST_DATABASE_URL` to run them against a real Postgres/Neon branch instead — useful when you want to
reproduce something against the provider itself — and the suites will write their rows there. `OTP_ECHO=1`
is forced for the scratch process only, which is what lets a suite sign in without an SMS provider. The
document-upload checks run against an in-memory fake S3 over `node:http`, so presigned PUT/GET/HEAD are
exercised without bucket credentials. Set `BASE_URL=http://127.0.0.1:3000`
to point `npm test` at a server that is already running instead — it will then write random-tagged drivers,
plates, IDs, phones and trips into **that** database, which is fine for a demo instance and not fine for a
live one. `TEST_PORT` picks the scratch port.

The suites read `ADMIN_PHONE` and `PAYSTACK_SECRET_KEY` from the same `.env` the server boots from, and every
provider-dependent assertion branches on what the *server* reports on `/api/health` rather than on the test
process's own environment — so the same suite is meaningful against a server with RRA / Paystack / MoMo keys
and against one without. It covers OTP issue/attempt/lockout and the resend cooldown, verify-token binding (a
token for one phone cannot sign up another), every KYC digit law and duplicate phone/ID/TIN/plate, the
credential-lookup fence (`400` without a `verify_token`, `422` on a malformed value, `503`/`200` per register
depending on whether it is wired), the pending/rejected access gates, the admin bootstrap from `ADMIN_PHONE`,
approve/reject/already-reviewed/incomplete-profile transitions, `403 admin_only` for non-admins including the
KYC re-check route, the RURA fare bands (including that a motorcycle is priced by the table and not by its own
rate), OpenStreetMap measuring a real Kigali journey instead of a straight line, the GPS fix endpoint and
nearby ranking, the `with_passenger` → offline → `available` cycle, the request state machine, ownership,
rating maths, earnings totals, webhook signatures, the whole 17,437-row division tree against the seed file it
was built from (per-level counts, cascading children, the `lang` parameter, search and chain, a centroid answer
that admits its distance, `location_code` on the rider profile and the `division` filter matching where a rider
works *or* where they were last seen), and — when keys are set — that payment attempts really leave
the process and a provider rejection surfaces as `502`, never as a fake success.

`npm run test:dashboards` covers every endpoint the three dashboards call: the rider inbox scopes,
`/stats` periods and `can_go_online` blockers, `NDITEGUYE`, the passenger sign-in/claim-trips round trip,
cancel and rating gates, saved places, the rider's division pick and the console's division filter — including
what each of them answers in Kinyarwanda — and each admin console read plus the rider/trip levers and their
`409` guards. It also walks the document lifecycle end to end: a rejected content type, a signed PUT that
really lands in the fake bucket, the `complete` call reading back the true byte count, and the admin's signed
GET returning exactly the bytes the rider uploaded. `npm run test:i18n` parses every dictionary in the
frontend — `I18N`/`EC` in `public/assets/auth.js`, the dropdown library's own `I18N`, the interview's `I18N` in
`public/assets/interview.js`, and the booking page's `I18N` plus its error map `T` — and fails if a key exists
in one language only, is declared twice, holds something the UI cannot render, or is referenced but never
defined — the guard that keeps a translated label from silently disappearing when a dashboard grows a new
control.

## Pages

| Path | Who | What |
| --- | --- | --- |
| `/` | Everyone | Rider search and booking — the passenger app, no dashboard of its own |
| `/passenger` | Passengers | Phone + OTP sign-in, own trips with receipts, cancel, rate, saved places, profile |
| `/rider` | Approved drivers | Inbox (live / history), earnings, ratings, profile with ID / licence / plate photo uploads, online + NDITEGUYE and GPS posting |
| `/login` | Drivers | Phone → OTP, or Google. Approved → `/rider`; shows waiting/rejected states instead of an error |
| `/signup` | New drivers | Names, ID (16 digits), TIN (9 digits), plate, verified phone, vehicle type; live RRA/NIDA verdict line per field once the phone is confirmed |
| `/admin` | `ADMIN_PHONE` only | Console: KYC queue with the uploaded ID / licence / plate photos, riders, trips, payments ledger, passengers, 7-day overview |
| `/guide` | Everyone | Bilingual how-to instructions, opened from the *Uko bikora* row in the header Menu |

`public/assets/auth.js` holds the shared ES5 library — dictionaries, the app header, the OTP widget and the
API helper — plus a page-controller registry. Each dashboard lives in its own file (`rider.js`,
`passenger.js`, `admin.js`) and registers itself with `SERE.onPage(name, init)`; the page's `<body
data-page="…">` picks which one boots. `auth.css` is the stylesheet for those pages. `/api/config` tells the
frontend the live-location window and whether Google is configured, so no credentials or mode flags are
hard-coded in the UI.

`/login`, `/signup`, `/rider`, `/passenger` and `/admin` mount the same header as the app — the SERE Moto logo,
the *Passenger* / *Rider* / *Ibyange* tabs, the **Menu** and the RW/EN toggle — so signing up, riding
or administering never looks like a different product. A driver's *Ibyange* link points at `/rider`, a
passenger's at `/passenger`; the account kind comes from `GET /api/auth/session`, which never confuses the two
token types. The console stays at `/admin`, reachable only from the Menu row that appears when the stored
session belongs to an admin. `/?view=mine` (the old account tab) forwards to `/passenger`.

The dropdown pickers are the shared `public/assets/divisions.js` component, used by `/rider` (own work area down
to cell) and `/admin` (riders filtered at sector depth); `/` loads the same file only for its `point()` and
`list()` calls and asks the passenger through `interview.js` instead. `/passenger` saves addresses as text plus
optional coordinates instead.

The header **Menu** (between the account icon and the RW/EN toggle) holds the main views — *Passenger*,
*Rider*, *Ibyange*, *Uko bikora* → `/guide`, plus the admin row when the session belongs to an admin — the
*Bari online gusa* / *Online riders only* switch and **Shyira app kuri Phone** / **Install app on Phone** — a
plain icon + title row, never a filled button. `public/manifest.json`, `public/sw.js` and the icons in
`public/assets/` make the app installable.
Browsers only offer the prompt in a secure context on a real domain, so test installation from the deployed
site (`localhost` also counts); while no prompt is pending the row stays hidden, and once the app is installed
the row shows the installed state in place.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/config` | – | `googleClientId`, `liveLocationSeconds`, the RURA `fare` table, the KYC digit laws (`kyc.phoneDigits` 10, `kyc.idDigits` 16, `kyc.tinDigits` 9) and which registers are wired |
| POST | `/api/auth/otp/send` | – | Screens the digits with the phone provider, then issues an OTP; `devCode` in the response only with `OTP_ECHO=1` |
| POST | `/api/auth/otp/verify` | – | Verify the OTP → session token, or `verify_token` for a new number |
| POST | `/api/auth/signup` | `verify_token` | KYC application → `status: pending`, with one register verdict per credential |
| POST | `/api/verify-tin` | `verify_token` | Ask RRA about a 9-digit TIN → `{valid, taxpayer, source}`; 12 lookups/hour per phone |
| POST | `/api/verify-id` | `verify_token` | Ask the ID register about a 16-digit number → `{exists, match, source}`; never echoes the register's name |
| POST | `/api/auth/google` | – | Verify a Google ID token → session token |
| GET | `/api/auth/me` | Bearer | Driver session identity: `status`, `isAdmin`, review `reason` |
| GET | `/api/auth/session` | Bearer | Kind-safe probe → `kind: passenger \| driver \| null` plus that account; the only route both token types may call |
| GET | `/api/drivers` | – | Search approved drivers: `q`, `zone`, `division`, `vehicle_type`, `service`, `online`, `available`, `near=<lat,lng>`, `max_km`, `lang` |
| GET | `/api/zones` | – | Every zone approved drivers work in |
| GET | `/api/drivers/me` | Bearer | Own record with live fields (`state`, `onTrip`, `live`, `locAgeSeconds`), pending included |
| PATCH | `/api/drivers/me` | Bearer | Update profile (allowed while pending); `location_code` sets the picked division |
| POST | `/api/drivers/me/complete` | Bearer | Set zone, services, capacity, slots (and `price_per_km` for a car) in one call |
| POST | `/api/drivers/me/online` | Bearer + approved | Toggle availability; going offline clears the stored position |
| POST | `/api/drivers/me/location` | Bearer + approved | Post the rider's GPS fix (`lat`, `lng`, optional `accuracy`); answers the sector it fell `around` |
| POST | `/api/drivers/me/ready` | Bearer + approved | NDITEGUYE: go online and drop a stale `with_passenger` flag |
| GET | `/api/drivers/me/documents` | Bearer | Own ID / licence / plate rows with `status`, `bytes` and a signed GET `url` once uploaded |
| POST | `/api/drivers/me/documents/:kind/upload-url` | Bearer | `kind` is `national_id`\|`driving_licence`\|`plate`; body `content_type` → presigned PUT `uploadUrl`, TTL `expiresIn`, `maxBytes`; marks the row `pending` |
| POST | `/api/drivers/me/documents/:kind/complete` | Bearer | HEAD the uploaded object, check type and size, mark `uploaded` with the real byte count |
| GET | `/api/drivers/me/requests` | Bearer + approved | Dashboard inbox, `scope=active\|history\|all` |
| GET | `/api/drivers/me/stats` | Bearer + approved | Trips/gross/payout per today-week-month, distance, unbilled total, rating distribution, `can_go_online` blockers |
| GET | `/api/drivers/me/ratings` | Bearer + approved | Latest comments with the star histogram |
| POST | `/api/drivers/:id/rating` | – | Rate an approved driver, `stars` 1–5 |
| GET | `/api/fare` | – | Quote a trip: `from`/`to` (optionally `near`), or `distance_km`, plus `vehicle`, `wait_minutes` |
| POST | `/api/requests` | – | Client sends a request (gates: not approved, offline, service, capacity). Returns `fare_components` |
| GET | `/api/requests/me` | Bearer + approved | Driver inbox |
| GET | `/api/requests/:id` | Bearer + approved | One request (owner only) |
| PATCH | `/api/requests/:id/status` | Bearer + approved | `seen` / `accepted` / `declined` / `completed` / `cancelled`; accepting sets `on_trip`, completing sets the rider offline |
| POST | `/api/requests/:id/payments` | – | Start MoMo or card payment for an accepted or completed trip (the amount is the stored fare, never the caller's) |
| GET | `/api/payments/:reference` | Bearer | Payment status (driver of that trip) |
| POST | `/api/payments/:reference/verify` | Bearer | Ask the provider to confirm |
| GET | `/api/earnings` | Bearer | Collected / payout / fee totals |
| POST | `/api/passenger/auth/verify` | – | Passenger phone + OTP → passenger token; claims guest trips booked on that number |
| GET | `/api/passenger/me` | Passenger | Profile, saved places, trip and rating counters |
| PATCH | `/api/passenger/me` | Passenger | Rename, set email |
| GET | `/api/passenger/trips` | Passenger | Own trips, `scope=active\|history\|all`, each with rider, payment and rating |
| GET | `/api/passenger/trips/:id` | Passenger | One own trip |
| POST | `/api/passenger/trips/:id/cancel` | Passenger | Cancel while `new` / `seen` / `accepted` |
| POST | `/api/passenger/trips/:id/rating` | Passenger | One 1–5 star rating per finished trip; feeds the rider's average |
| GET | `/api/passenger/places` | Passenger | Saved addresses |
| POST | `/api/passenger/places` | Passenger | Save `label`, `address`, optional `lat`/`lng` |
| DELETE | `/api/passenger/places/:id` | Passenger | Remove a saved address |
| GET | `/api/admin/applications` | Bearer + admin | Queue by `status` (default `pending`) |
| POST | `/api/admin/applications/:id/decision` | Bearer + admin | `action: approve` or `reject` (+ reason, optional profile) |
| POST | `/api/admin/applications/:id/verify` | Bearer + admin | `check: tin\|id\|phone` — force one register lookup and store its verdict on the applicant |
| GET | `/api/admin/riders` | Bearer + admin | Riders with per-rider trips, gross, payout and their two divisions; `status`, `vehicle_type`, `online`, `division`, `q`, `lang` |
| POST | `/api/admin/riders/:id/action` | Bearer + admin | `suspend` (with reason) / `reinstate` / `offline`; also cancels that rider's open trips |
| GET | `/api/admin/riders/:id/documents` | Bearer + admin | That rider's ID / licence / plate rows with short-lived signed GET links for review |
| GET | `/api/admin/trips` | Bearer + admin | Trips with rider, payment and rating state; `scope`, `kind`, `driver_id`, `q` |
| POST | `/api/admin/trips/:id/cancel` | Bearer + admin | Force-cancel an open trip and free the rider |
| GET | `/api/admin/payments` | Bearer + admin | Ledger with platform totals; `status`, `provider`, `q` |
| GET | `/api/admin/passengers` | Bearer + admin | Passenger accounts with trip, spend and saved-place counts |
| GET | `/api/admin/stats` | Bearer + admin | Driver, request, payment and rating totals (counted in Kigali time) |
| GET | `/api/admin/overview` | Bearer + admin | 7-day series, per-zone / provider / kind breakdowns, top riders with their division, webhook health |
| POST | `/api/webhooks/paystack` | signature | Provider callback |
| POST | `/api/webhooks/mtn-momo` | checksum | Provider callback |
| GET | `/api/health` | – | Table counts plus `drivers`, `requests` and `tripsCompleted` (the three numbers the booking page shows as *Abamotari* / *Abiteguye* / *Abatwaye*), payment provider readiness, the `kyc` block (`smsProvider`, `rra`, `idProvider`, `phoneCheck` — `false`,
`"numverify"` or `"generic"`, so the reader learns *which* service answers for a phone number, `strict`), the `storage` block (`configured`, `bucket`, `maxUploadBytes`), the `divisions` block (rows loaded, per-level counts, mapped centroids, seed file), `adminConfigured` |

Errors are `{"error": "<code>", "message": "<english detail>"}`. The UI translates the code, so the code
names are part of the contract: `invalid_phone`, `invalid_code`, `otp_invalid`, `otp_expired`,
`otp_attempts_exceeded`, `otp_rate_limited`, `sms_send_failed`, `sms_not_configured`, `invalid_verify_token`,
`phone_not_verified`, `invalid_names`, `invalid_id_number`, `invalid_tin_number`, `invalid_plate`,
`phone_taken`, `id_number_taken`, `tin_number_taken`, `plate_taken`, `account_pending`, `already_reviewed`,
`incomplete_profile`, `admin_only`, `invalid_check`, `tin_check_unavailable`, `id_check_unavailable`,
`phone_check_unavailable`, `tin_not_found`, `id_not_found`, `id_name_mismatch`, `phone_not_live`,
`kyc_rate_limited`, `kyc_unreachable`, `google_not_configured`, `google_token_invalid`, `google_token_expired`,
`google_signature_invalid`, `google_key_unknown`, `google_audience_mismatch`, `google_issuer_mismatch`,
`google_lookup_failed`, `invalid_google_token`, `application_not_found`, `invalid_email`, `driver_unavailable`,
`driver_offline`, `driver_busy`, `driver_not_found`, `profile_incomplete`, `service_not_offered`,
`capacity_exceeded`, `not_payable`, `invalid_status`, `invalid_status_change`, `authentication_required`,
`place_not_found`, `invalid_near`, `invalid_distance_km`, `invalid_location_code`, `invalid_division`,
`invalid_level`, `invalid_code`, `division_not_found`, `divisions_unavailable`, `divisions_unmapped`,
`paystack_not_configured`, `momo_not_configured`, `provider_unreachable`, `storage_not_configured`,
`unsupported_document_type`, `document_too_large`, `document_not_uploaded`, `document_not_started`.

## Data

The Neon database holds fifteen tables: `drivers`, `passengers`, `passenger_places`,
`ride_requests`, `trip_ratings`, `payments`, `otp_challenges`, `webhook_events`, `driver_documents`
(one row per rider per document kind, with bucket key, declared type, real byte count from HEAD, and a
`pending` → `uploaded` status), the OpenStreetMap caches
`places` (name + anchor → coordinates) and `routes` (pair → distance), the three register verdict caches
`tin_checks`, `id_checks` and `phone_checks`, and the read-only `locations` tree. There is no database file:
the schema lives in `src/schema.js` and is applied on every boot, idempotently, against whatever
`DATABASE_URL` points at — Neon's own point-in-time history is the backup. `data/locations.json` and
`data/division-coords.json` are committed: they are the app's geography, and a deploy without them has no
divisions to offer. Every driver row carries the picked division as `loc_code` plus the leaf's level and its
`province_code` / `district_code` / `sector_code` ancestors (copied down so a district filter is one column
test, not a tree walk per request) and the sector its last fix fell nearest to as `live_code`. OTP codes are stored as salted SHA-256 hashes with an expiry
and an attempt counter — a code is consumed on first use, so it cannot be replayed. `webhook_events` has a
unique `(provider, external_id)` so a retried provider callback can never pay a trip twice. Each check table
is keyed by the value looked up (`tin`, `id_number`, `phone`) and stores the verdict, the evidence the register
returned (taxpayer name, holder name, operator), the `source`, a `note` with the unreadable body when the
answer could not be parsed, and `checked_at` — so an audit can always say *who confirmed this, and when*, and a
re-check does not pay for the same lookup twice inside its window.

Timestamps stay ISO-like UTC text (`YYYY-MM-DD HH24:MI:SS`) rather than `timestamptz`, because the whole API
and both frontends already speak that format; `src/schema.js` installs a small PL/pgSQL `datetime(text,
VARIADIC text[])` shim so the existing `datetime('now')` / `datetime('now', '-24 hours')` calls keep their
meaning on Postgres. There is no migration step: `src/schema.js` is written as `CREATE TABLE IF NOT EXISTS`
with named constraints, so applying it to an existing Neon database is a no-op and a redeploy never needs a
dump-and-restore.

## Deploy

The server binds `HOST`/`PORT` and serves the static UI from `public/`, so one process is the whole app.

```
HOST=0.0.0.0 PORT=3000 PUBLIC_URL=https://your-domain.rw npm start
```

* **VPS / Hostinger**: `npm ci --omit=dev`, put nginx in front with `proxy_pass http://127.0.0.1:3000`, and
  point DNS at the machine. Providers need HTTPS callbacks, so `PUBLIC_URL` must be the real domain before
  you register webhooks. Run under `pm2 start server.js --name seremoto --interpreter node` — there is no
  `ExperimentalWarning` to silence any more — and nothing needs a persistent disk beyond the checked-in
  `data/*.json` files.
* **Vercel** (frontend and API in one project): `public/` is served as static files, and every `/api/*` call is
  rewritten to the Node function `api/index.js`, which imports the same Express app that `server.js` listens
  with — the wiring lives in `vercel.json`. `src/app.js` holds the app; `server.js` only binds `HOST`/`PORT` for
  `npm start`, and a function never calls `listen`.

  ```
  npm i -g vercel
  vercel login
  vercel link                                   # project name: seremoto
  vercel env add DATABASE_URL production        # Neon pooled string, ?sslmode=require
  vercel env add JWT_SECRET production          # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  vercel env add PUBLIC_URL production          # https://<project>.vercel.app or your domain
  vercel env add ADMIN_PHONE production         # the number that must own /admin
  vercel env add SMS_PROVIDER production        # africastalking | twilio | generic
  vercel env add SMS_PROVIDER_KEY production    # the provider's API key — without it no OTP is ever sent
  vercel env add S3_BUCKET production           # plus S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
  vercel deploy --prod
  ```

  Vercel puts these into `process.env` itself: there is no `.env` file in the build, `dotenv` finds nothing and
  the platform values are used as-is, so `.env` stays gitignored and never has to be uploaded. `PORT` and
  `HOST` are ignored — the runtime invokes the function. Node 22 is pinned in `package.json` because Vercel
  only accepts an exact major. Fill the database once from a checkout before the first deploy —
  `npm run seed:locations` loads the 17,437 divisions, and the app only ever reads them back out of Postgres
  after that, because a function bundle does not carry `data/locations.json`. `functions."api/index.js".maxDuration`
  is 60 seconds for that same first boot, which also creates the fifteen tables; every later start just reads
  them. Neon holds
  the data, so scale-to-zero is safe and nothing needs a disk beyond the checked-in `data/*.json`. Keep
  `DATABASE_POOL_MAX` at 10: each warm function keeps its own pool. Do not add `OTP_ECHO`.
  `vercel.json` keeps `cleanUrls` plus the `/api/(.*)` rewrite — without that rewrite the function stops
  answering anything under `/api`. Vercel does not bind `/` to `public/index.html` either, so the landing page
  is served by `src/app.js` from `src/landing.js`, a generated copy of the same HTML that the bundler can
  trace. Edit `public/index.html`, then run `npm run landing`; the smoke suite fails if the two drift apart.
  Paystack and MoMo verify their signature over the raw bytes; Vercel may hand the function an already-parsed
  body, so `src/routes/webhooks.js` falls back to re-serialising `req.body`, which reproduces the compact JSON
  both providers post.
* **Qoder Sites**: choose the Node runtime for the site, then a managed deploy that starts with
  `npm --prefix seremoto start` and binds the platform-provided `PORT` variable. Set the rest as environment
  secrets (never in code), including `DATABASE_URL` — the database lives in Neon, not on the container, so a
  redeploy or a scale-to-zero does not touch a byte of data.
* Set `DATABASE_URL`, `PAYSTACK_SECRET_KEY`, the `MOMO_*` values, `SMS_PROVIDER_KEY` (plus `SMS_USERNAME` or
  `SMS_TWILIO_ACCOUNT_SID`, whichever `SMS_PROVIDER` you chose), `GOOGLE_CLIENT_ID`, the `RRA_*` /
  `ID_*` / `PHONE_CHECK_*` values and the `S3_*` block in the platform's secret store, then load them with the
  real domain: `DATABASE_URL=postgresql://…?sslmode=require`,
  `PAYSTACK_SECRET_KEY=sk_live_...`,
  `MOMO_BASE_URL=https://<host-from-mtn>/api/v3`,
  `MOMO_CALLBACK_BASE=https://your-domain.rw`.
* **Before the first public login**: delete `OTP_ECHO` from the production `.env`, set `ADMIN_PHONE` to the
  number that should really hold the console (not the `0788210345` used during development), and configure the
  SMS provider so codes leave the process instead of only reaching the server log — with no provider key a
  customer can never log in, because the code they are waiting for was never sent. `npm start` prints
  `OTP_ECHO=1` and every missing `RRA_*` / `ID_*` / `PHONE_CHECK_*` block as outstanding problems if they
  survive into the deploy. Decide whether `KYC_STRICT=1` belongs in that deploy: it is the only mode where an
  application cannot be filed while a register is unreachable, so it needs the contracts to be live first.
* Add `https://your-domain.rw` to the Google client's authorized origins — the token is rejected as
  `google_token_invalid` if its `aud` is not the `GOOGLE_CLIENT_ID` you configured.
* `public/sw.js` is network-first and never caches `/api/`, so a deploy is live immediately; only the offline
  fallback page comes from the cache. Installability needs HTTPS, which the nginx block above already provides.
* The division tree seeds itself on first boot. After a deploy, `curl $PUBLIC_URL/api/health` must report
  `divisions.loaded` 17437 and a non-zero `centroids` — if it reads 0, `data/locations.json` or
  `data/division-coords.json` did not reach the server and every dropdown answers `503 divisions_unavailable`.

## Out of scope

Push notifications, insurance documents and background checks beyond the ID/TIN/plate fields, in-app chat,
dispute handling and receipts. Client contact is handed to WhatsApp by design — this keeps the app usable
for riders who only have a phone number and no account.
