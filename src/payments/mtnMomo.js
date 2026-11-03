import crypto from 'node:crypto';
import { config } from '../config.js';
import { ApiError } from '../validate.js';

const credentials = () => {
  const { baseUrl, userId, subscriptionKey, primaryKey, apiKey } = config.momo;
  if (!baseUrl || !userId || !subscriptionKey || !primaryKey || !apiKey) {
    throw new ApiError(503, 'momo_not_configured', 'Mobile Money payments are not live yet');
  }
  return { baseUrl, userId, subscriptionKey, primaryKey, apiKey };
};

const baseHeaders = () => {
  const { userId, primaryKey, apiKey } = credentials();
  return {
    'Ocp-Apim-Subscription-Key': primaryKey,
    'X-Target-API-User': userId,
    'X-Target-API-Key': apiKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
};

let cachedToken = null;

async function accessToken() {
  const { userId, subscriptionKey } = credentials();
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;

  const response = await fetch(`${config.momo.baseUrl}/collections/authenticate`, {
    method: 'POST',
    headers: {
      ...baseHeaders(),
      Authorization: `Basic ${Buffer.from(`${userId}:${subscriptionKey}`).toString('base64')}`,
    },
    body: JSON.stringify({ grant_type: 'client_credentials', client_secret: subscriptionKey }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new ApiError(502, 'momo_auth_failed', json.message || `MoMo authentication failed with HTTP ${response.status}`);
  }
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + Math.max(60, Number(json.expires_in) || 3600) * 1000,
  };
  return cachedToken.value;
}

async function call(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${config.momo.baseUrl}${pathname}`, {
    method,
    headers: { ...baseHeaders(), Authorization: `Bearer ${await accessToken()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(502, 'momo_rejected', json.message || `MoMo responded with HTTP ${response.status}`);
  }
  return json;
}

// MTN's callback carries x-checksum as MD5 of the raw body; some portal versions
// hash the body with the subscription key appended, so both digests are accepted.
const checksumMatches = (rawBody, checksum) => {
  const { subscriptionKey } = credentials();
  const provided = String(checksum || '').toLowerCase();
  const candidates = [
    crypto.createHash('md5').update(rawBody).digest('hex'),
    crypto.createHash('md5').update(`${rawBody}${subscriptionKey}`).digest('hex'),
  ];
  return candidates.some((digest) => digest === provided);
};

export const mtnMomo = {
  id: 'mtn_momo',
  label: 'MTN Mobile Money',
  methods: ['momo'],

  async initiate({ reference, amountRwf, payer, description }) {
    const body = {
      amount: String(amountRwf),
      currency: 'RWF',
      externalId: reference,
      payer: { partyIdType: 'MSISDN', partyId: payer.phone },
      payerNote: description,
      payeeNote: 'SERE Moto fare',
      provider: 'MTN',
      callback: `${config.momo.callbackBase || config.publicUrl}/api/webhooks/mtn-momo`,
    };
    const json = await call('/collections/request-payment', { method: 'POST', body });
    return {
      checkoutUrl: null,
      payerPrompt: 'The payer approves the request on their handset.',
      providerReference: json.externalId || reference,
      raw: json,
    };
  },

  async verify(reference) {
    const json = await call(`/transaction-status/getstatus/${encodeURIComponent(reference)}`);
    const status = String(json.status || '').toUpperCase();
    const paid = status === 'SUCCESSFUL' || status === 'SUCCESS';
    return { paid, status: paid ? 'paid' : status.toLowerCase(), raw: json };
  },

  parseWebhook({ rawBody, headers }) {
    if (!checksumMatches(rawBody, headers['x-checksum'])) {
      throw new ApiError(401, 'bad_webhook_signature', 'MoMo checksum does not match the request body');
    }
    const payload = JSON.parse(rawBody || '{}');
    const status = String(payload.status || '').toUpperCase();
    return {
      reference: payload.externalId,
      paid: status === 'SUCCESSFUL' || status === 'SUCCESS',
      raw: payload,
    };
  },
};
