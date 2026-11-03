import crypto from 'node:crypto';
import { config } from '../config.js';
import { ApiError } from '../validate.js';

const MINOR_UNITS_PER_RWF = 100;

const ensureKey = () => {
  if (!config.paystack.secretKey) {
    throw new ApiError(503, 'paystack_not_configured', 'Card payments are not live yet');
  }
  return config.paystack.secretKey;
};

async function call(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${config.paystack.baseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${ensureKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.status === false) {
    throw new ApiError(502, 'paystack_rejected', json.message || `Paystack responded with HTTP ${response.status}`);
  }
  return json.data;
}

const signatureMatches = (rawBody, signature) => {
  const digest = crypto.createHmac('sha512', ensureKey()).update(rawBody).digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export const paystack = {
  id: 'paystack',
  label: 'Card (Paystack)',
  methods: ['card', 'bank', 'ussd'],

  async initiate({ reference, amountRwf, payer, description }) {
    const data = await call('/transaction/initialize', {
      method: 'POST',
      body: {
        email: payer.email,
        amount: amountRwf * MINOR_UNITS_PER_RWF,
        currency: 'RWF',
        reference,
        metadata: { description, product: 'seremoto' },
      },
    });
    return {
      checkoutUrl: data.authorization_url,
      accessCode: data.access_code,
      providerReference: data.reference || reference,
      raw: data,
    };
  },

  async verify(reference) {
    const data = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
    const paid = data.status === 'success';
    return { paid, status: paid ? 'paid' : data.status, raw: data };
  },

  parseWebhook({ rawBody, headers }) {
    if (!signatureMatches(rawBody, headers['x-paystack-signature'])) {
      throw new ApiError(401, 'bad_webhook_signature', 'Paystack signature does not match the request body');
    }
    const payload = JSON.parse(rawBody || '{}');
    const data = payload.data || {};
    return {
      reference: data.reference,
      paid: payload.event === 'charge.success' && data.status === 'success',
      raw: data,
    };
  },
};
