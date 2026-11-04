/* SERE Moto — OTP delivery over a real SMS aggregator.

   Every provider answers in its own dialect, so each one gets an explicit adapter that reads
   that dialect instead of trusting HTTP 200. An aggregator that returns 200 with a per-recipient
   failure would otherwise let a code be "sent" that never reached the SIM card, and the rider
   would sit waiting for a message that does not exist. The provider's own message id is stored
   on the challenge so a delivery dispute can be opened with something the provider recognises. */
import { config } from './config.js';
import { ApiError } from './validate.js';

const DELIVERED = ['success', 'submitted', 'buffered', 'sent', 'queued', 'accepted', 'delivered', 'scheduled', 'true'];

const international = (phone) => `+250${phone.slice(1)}`;

async function post(url, { headers, json, form, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: form ? new URLSearchParams(form).toString() : JSON.stringify(json),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/* Providers do not all answer a refusal in JSON — Africa's Talking rejects a bad API key with a
   plain-text body — so the reason is read out of whichever shape came back instead of dropped. */
const refusalReason = (body, text) => {
  if (body) {
    const nested = body.SMSMessageData && body.SMSMessageData.Message;
    return body.errorMessage || body.message || body.detail || nested || '';
  }
  return String(text || '').trim().slice(0, 160);
};

const readBody = async (response) => {
  const text = await response.text().catch(() => '');
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = refusalReason(body, text);
    throw new ApiError(502, 'sms_send_failed', `The SMS provider replied with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  if (text && body === null) {
    throw new ApiError(502, 'sms_send_failed', `The SMS provider replied with something that is not JSON: ${text.slice(0, 120)}`);
  }
  return body || {};
};

/* Walks the provider's own status words; anything that is not a known-delivered word is a failure. */
function assertDelivered(status, provider, detail) {
  const word = String(status ?? 'success').trim().toLowerCase();
  if (DELIVERED.includes(word)) return;
  /* Africa's Talking also sends a numeric code beside the word; 1xx/2xx is its own way of saying
     "taken", 4xx/5xx is the refusal. */
  if (/^[12]\d{1,2}$/.test(word)) return;
  throw new ApiError(502, 'sms_send_failed', `${provider} refused the message${detail ? `: ${detail}` : ` (status ${status})`}`);
}

const africastalking = async (phone, message) => {
  if (!config.sms.username || !config.sms.key) {
    throw new ApiError(503, 'sms_not_configured', 'SMS_USERNAME and SMS_PROVIDER_KEY are required for Africa\'s Talking');
  }
  const form = { username: config.sms.username, to: international(phone), message };
  /* An empty "from" is a refused request, not a default one — the account's own sender answers
     only when the field is left out. */
  if (config.sms.sender) form.from = config.sms.sender;
  const response = await post(config.sms.url || 'https://api.africastalking.com/version1/messaging', {
    headers: { apiKey: config.sms.key },
    form,
    timeoutMs: config.sms.timeoutMs,
  });
  const body = await readBody(response);
  const data = body.SMSMessageData || {};
  const recipient = (data.Recipients || [])[0];
  if (!recipient) {
    throw new ApiError(502, 'sms_send_failed', `Africa's Talking queued nothing${data.Message ? `: ${data.Message}` : ''}`);
  }
  assertDelivered(recipient.status ?? recipient.statusCode, "Africa's Talking", recipient.errorMessage || data.Message);
  return { ref: recipient.messageId || null };
};

const twilio = async (phone, message) => {
  const sid = config.sms.accountSid || config.sms.username;
  if (!sid || !config.sms.key) {
    throw new ApiError(503, 'sms_not_configured', 'SMS_TWILIO_ACCOUNT_SID and SMS_PROVIDER_KEY are required for Twilio');
  }
  const url = config.sms.url || `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const response = await post(url, {
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${config.sms.key}`).toString('base64')}` },
    form: { To: international(phone), From: config.sms.sender, Body: message },
    timeoutMs: config.sms.timeoutMs,
  });
  const body = await readBody(response);
  if (!body || !body.sid) throw new ApiError(502, 'sms_send_failed', 'Twilio returned no message SID');
  assertDelivered(body.status, 'Twilio', body.message);
  return { ref: body.sid };
};

/* Any aggregator that takes POST JSON {to, from, message} with an Authorization header.
   A body that carries its own status flag has to say the message was accepted. */
const generic = async (phone, message) => {
  if (!config.sms.url || !config.sms.key) {
    throw new ApiError(503, 'sms_not_configured', 'SMS_PROVIDER_URL and SMS_PROVIDER_KEY are required');
  }
  const response = await post(config.sms.url, {
    headers: { Authorization: `Bearer ${config.sms.key}` },
    json: { to: international(phone), from: config.sms.sender, message },
    timeoutMs: config.sms.timeoutMs,
  });
  const body = await readBody(response);
  const status = body && (body.status ?? body.success ?? body.result);
  const detail = body && (body.message || body.error || body.errorMessage);
  assertDelivered(status === undefined || status === null ? 'success' : status, config.sms.provider, detail);
  return { ref: (body && (body.id || body.messageId || body.data && body.data.id)) || null };
};

const ADAPTERS = { africastalking, twilio, generic };

export const smsProviderName = () => (ADAPTERS[config.sms.provider] ? config.sms.provider : 'generic');

/* Sends for real, or says clearly that it did not. Nothing in here prints or returns the code. */
export async function sendSms(phone, message) {
  const provider = smsProviderName();
  const adapter = ADAPTERS[provider] || generic;
  const { ref } = await adapter(phone, message);
  return { provider, ref };
}
