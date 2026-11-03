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
  sms: {
    provider: (process.env.SMS_PROVIDER || 'generic').toLowerCase(),
    url: process.env.SMS_PROVIDER_URL || '',
    key: process.env.SMS_PROVIDER_KEY || '',
    username: process.env.SMS_USERNAME || '',
    sender: process.env.SMS_SENDER_ID || 'SEREMOTO',
    accountSid: process.env.SMS_TWILIO_ACCOUNT_SID || '',
    timeoutMs: num(process.env.SMS_TIMEOUT_MS, 10000),
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
  adminPhone: process.env.ADMIN_PHONE ? process.env.ADMIN_PHONE.replace(/[^0-9]/g, '') : '',
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
  /* Development only: when true, an OTP is returned in the API response so tools can sign in without SMS. */
  otpEcho: process.env.OTP_ECHO === '1',
  otp: {
    ttlSeconds: num(process.env.OTP_TTL_SECONDS, 300),
    maxAttempts: num(process.env.OTP_MAX_ATTEMPTS, 3),
    resendSeconds: num(process.env.OTP_RESEND_SECONDS, 30),
    maxPerHour: num(process.env.OTP_MAX_PER_HOUR, 8),
  },
};

/* Delivery counts as configured only when the chosen provider has what its own API needs:
   Africa's Talking wants a username, Twilio an account SID, anything else an explicit URL. */
export const smsConfigured = () => {
  if (!config.sms.key) return false;
  if (config.sms.provider === 'africastalking') return Boolean(config.sms.username);
  if (config.sms.provider === 'twilio') return Boolean(config.sms.accountSid || config.sms.username);
  return Boolean(config.sms.url);
};

export const otpDevMode = () => !smsConfigured();

export const storageConfigured = () => Boolean(
  config.storage.bucket && config.storage.accessKeyId && config.storage.secretAccessKey,
);

/* Names the vars the selected provider is actually missing, so the boot log cannot send an
   Africa's Talking user off to configure a URL they never use. */
function smsSetupHint() {
  if (config.sms.provider === 'africastalking') return 'SMS_USERNAME + SMS_PROVIDER_KEY';
  if (config.sms.provider === 'twilio') return 'SMS_TWILIO_ACCOUNT_SID + SMS_PROVIDER_KEY';
  return 'SMS_PROVIDER_URL + SMS_PROVIDER_KEY';
}

export const kycHealth = () => ({
  smsProvider: otpDevMode() ? 'none' : config.sms.provider,
  rra: Boolean(config.rra.baseUrl && (config.rra.apiKey || (config.rra.username && config.rra.password))),
  idProvider: config.idCheck.url ? (config.idCheck.provider || 'generic') : null,
  phoneCheck: Boolean(config.phoneCheck.url && config.phoneCheck.key),
  strict: config.kycStrict,
});

export const missingConfig = () => {
  const problems = [];
  if (config.jwtSecret.length < 32) problems.push('JWT_SECRET (>=32 chars)');
  if (!config.paystack.secretKey) problems.push('PAYSTACK_SECRET_KEY');
  if (!config.momo.userId) problems.push('MOMO_USER_ID');
  if (otpDevMode()) problems.push(`${smsSetupHint()} (OTP codes are only printed to the server console)`);
  if (config.otpEcho) problems.push('OTP_ECHO=1 (codes are returned in the API response — remove it before going live)');
  if (!config.rra.baseUrl) problems.push('RRA_BASE_URL + RRA_API_KEY (TIN numbers are format-checked only, never looked up at RRA)');
  if (!config.idCheck.url) problems.push('ID_CHECK_URL + ID_CHECK_KEY (national ID numbers are format-checked only, never matched against NIDA)');
  if (!config.phoneCheck.url) problems.push('PHONE_CHECK_URL + PHONE_CHECK_KEY (phone numbers are format-checked only)');
  if (!config.google.clientId) problems.push('GOOGLE_CLIENT_ID (Google sign-in returns 503)');
  if (!config.adminPhone) problems.push('ADMIN_PHONE (no account can become an admin)');
  if (!storageConfigured()) problems.push('S3_BUCKET + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY (rider documents cannot be uploaded)');
  return problems;
};
