import 'dotenv/config';

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${num(process.env.PORT, 3000)}`,
  /* Neon hands out a postgres:// URL. There is no local file fallback: without it the app refuses
     to start rather than pretending to hold data it cannot reach. */
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: (process.env.DATABASE_SSL || '').toLowerCase(),
  databasePoolMax: num(process.env.DATABASE_POOL_MAX, 10),
  jwtSecret: process.env.JWT_SECRET || '',
  sessionHours: num(process.env.SESSION_HOURS, 720),
  commissionPercent: num(process.env.PLATFORM_COMMISSION_PERCENT, 5),
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY || '',
    baseUrl: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
  },
  momo: {
    baseUrl: process.env.MOMO_BASE_URL || '',
    userId: process.env.MOMO_USER_ID || '',
    subscriptionKey: process.env.MOMO_SUBSCRIPTION_KEY || '',
    primaryKey: process.env.MOMO_PRIMARY_KEY || '',
    apiKey: process.env.MOMO_API_KEY || '',
    productId: process.env.MOMO_PRODUCT_ID || '',
    callbackBase: process.env.MOMO_CALLBACK_BASE || '',
  },
  /* RRA taxpayer lookup. The base URL comes from the RRA API contract — it is not guessable. */
  rra: {
    baseUrl: (process.env.RRA_BASE_URL || '').replace(/\/+$/, ''),
    path: process.env.RRA_TIN_PATH || '/customers/selectCustomer',
    style: (process.env.RRA_TIN_STYLE || 'query').toLowerCase(),
    field: process.env.RRA_TIN_FIELD || 'tin',
    apiKey: process.env.RRA_API_KEY || '',
    username: process.env.RRA_USERNAME || '',
    password: process.env.RRA_PASSWORD || '',
    validField: process.env.RRA_VALID_FIELD || '',
    nameField: process.env.RRA_NAME_FIELD || '',
    timeoutMs: num(process.env.RRA_TIMEOUT_MS, 10000),
  },
  /* National ID match against NIDA (or peleza.com, or any contract you are handed). */
  idCheck: {
    provider: (process.env.ID_PROVIDER || '').toLowerCase(),
    url: process.env.ID_CHECK_URL || '',
    key: process.env.ID_CHECK_KEY || '',
    username: process.env.ID_USERNAME || '',
    password: process.env.ID_PASSWORD || '',
    matchField: process.env.ID_MATCH_FIELD || '',
    nameField: process.env.ID_NAME_FIELD || '',
    timeoutMs: num(process.env.ID_TIMEOUT_MS, 10000),
  },
  phoneCheck: {
    url: process.env.PHONE_CHECK_URL || '',
    key: process.env.PHONE_CHECK_KEY || '',
    timeoutMs: num(process.env.PHONE_CHECK_TIMEOUT_MS, 10000),
  },
  /* numverify (apilayer.com) checks a number against the international numbering plan. Sign-in rests
     on it now that no SMS code is sent at all, so an outage refuses the login rather than guessing.
     It is not an HLR probe, so a "valid" verdict never means somebody holds that SIM.
     The key is served over two hosts — https://apilayer.net/api (the numverify plan-check host)
     and https://api.apilayer.com/number_verification (their gateway); the old
     api.apilayer.com/numverify route was withdrawn and answers 404. */
  numverify: {
    key: process.env.NUMVERIFY_ACCESS_KEY || '',
    baseUrl: (process.env.NUMVERIFY_BASE_URL || 'https://apilayer.net/api').replace(/\/+$/, ''),
    timeoutMs: num(process.env.NUMVERIFY_TIMEOUT_MS, 10000),
  },
  /* The booking conversation. Any OpenAI-compatible chat endpoint: the key stays on the server and
     the model is only ever asked for wording, never for a price, a place or a count. */
  ai: {
    baseUrl: (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || 'gpt-4o',
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 12000),
  },
  /* With 1 every configured check must return a verdict before a signup is accepted. */
  kycStrict: process.env.KYC_STRICT === '1',
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    certsUrl: process.env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs',
  },
  /* Any S3-compatible bucket (AWS, Cloudflare R2, Backblaze, MinIO). Keys never leave the server:
     riders upload straight to the bucket with a short-lived signed PUT and admins read with a signed GET. */
  storage: {
    endpoint: process.env.S3_ENDPOINT || '',
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1',
    signedUrlTtlSeconds: num(process.env.S3_SIGNED_URL_TTL_SECONDS, 300),
    maxUploadBytes: num(process.env.S3_MAX_UPLOAD_MB, 8) * 1024 * 1024,
  },
  /* The console owner is recognised by email, because that is what a rider signs in with now. The
     first account to claim this address becomes an admin — stored and compared lowercased, exactly
     the way the signup form stores an address, so ADMIN_EMAIL=Anyone@Example.com still matches. */
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  /* RURA Board Decision 03/BD/RD-TRP/2021 as adjusted August 2022 — override only when RURA issues a new decision. */
  fare: {
    motorcycleFirstBandKm: num(process.env.FARE_MOTO_FIRST_KM, 2),
    motorcycleMinFareRwf: num(process.env.FARE_MOTO_MIN_RWF, 400),
    motorcycleMidBandKm: num(process.env.FARE_MOTO_MID_BAND_KM, 40),
    motorcycleMidRateRwf: num(process.env.FARE_MOTO_RATE_RWF, 117),
    motorcycleLongRateRwf: num(process.env.FARE_MOTO_LONG_RATE_RWF, 187),
    motorcycleFreeWaitMinutes: num(process.env.FARE_FREE_WAIT_MIN, 10),
    motorcycleWaitRateRwf: num(process.env.FARE_WAIT_RWF_PER_MIN, 21),
  },
  osm: {
    routingUrl: process.env.OSRM_BASE_URL || 'https://router.project-osrm.org',
    geocodingUrl: process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org',
    userAgent: process.env.OSM_USER_AGENT || 'SEREMoto/1.0 (support@sere.moto)',
    timeoutMs: num(process.env.OSM_TIMEOUT_MS, 8000),
  },
  liveLocationSeconds: num(process.env.LIVE_LOCATION_SECONDS, 180),
};

export const storageConfigured = () => Boolean(
  config.storage.bucket && config.storage.accessKeyId && config.storage.secretAccessKey,
);

export const aiConfigured = () => Boolean(config.ai.apiKey);

export const kycHealth = () => ({
  rra: Boolean(config.rra.baseUrl && (config.rra.apiKey || (config.rra.username && config.rra.password))),
  idProvider: config.idCheck.url ? (config.idCheck.provider || 'generic') : null,
  phoneCheck: config.numverify.key ? 'numverify'
    : (config.phoneCheck.url && config.phoneCheck.key ? 'generic' : false),
  strict: config.kycStrict,
});

export const missingConfig = () => {
  const problems = [];
  if (config.jwtSecret.length < 32) problems.push('JWT_SECRET (>=32 chars)');
  if (!config.paystack.secretKey) problems.push('PAYSTACK_SECRET_KEY');
  if (!config.momo.userId) problems.push('MOMO_USER_ID');
  if (!config.rra.baseUrl) problems.push('RRA_BASE_URL + RRA_API_KEY (TIN numbers are format-checked only, never looked up at RRA)');
  if (!config.idCheck.url) problems.push('ID_CHECK_URL + ID_CHECK_KEY (national ID numbers are format-checked only, never matched against NIDA)');
  if (!config.numverify.key && !config.phoneCheck.url) {
    problems.push('NUMVERIFY_ACCESS_KEY (passengers cannot sign in and a rider phone cannot be screened)');
  }
  if (!config.google.clientId) problems.push('GOOGLE_CLIENT_ID (Google sign-in returns 503)');
  if (!aiConfigured()) problems.push('AI_API_KEY (the booking interview keeps its scripted questions and answers none)');
  if (!config.adminEmail) problems.push('ADMIN_EMAIL (no account can become an admin)');
  if (!storageConfigured()) problems.push('S3_BUCKET + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY (rider documents cannot be uploaded)');
  return problems;
};
