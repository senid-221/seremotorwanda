import { Router } from 'express';
import { get, run } from '../db.js';
import { paystack } from '../payments/paystack.js';
import { mtnMomo } from '../payments/mtnMomo.js';
import { ApiError } from '../validate.js';
import { recordWebhook } from './payments.js';

const router = Router();

/* A serverless runtime can hand the handler an already-parsed body, leaving express.json's raw buffer
   empty. Both providers post compact JSON, so re-serialising reproduces the signed bytes. */
const rawBodyOf = (req) => req.rawBody || (req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '');

async function receive(provider, req, res) {
  const parsed = provider.parseWebhook({ rawBody: rawBodyOf(req), headers: req.headers });
  if (!parsed.reference) throw new ApiError(422, 'missing_reference', 'Callback carried no payment reference');

  const payment = await get('SELECT * FROM payments WHERE provider_reference = ?', parsed.reference);
  const fresh = await recordWebhook({
    provider: provider.id,
    reference: parsed.reference,
    payload: parsed.raw,
    error: payment ? null : 'unknown_reference',
  });

  if (!payment) return res.json({ received: true, ignored: 'unknown_reference' });
  if (!fresh) return res.json({ received: true, duplicate: true, reference: parsed.reference });

  const status = parsed.paid ? 'paid' : 'failed';
  await run(`UPDATE payments SET status = ?, confirm_response = ?, confirmed_at = ${parsed.paid ? "datetime('now')" : 'NULL'} WHERE id = ?`,
    status, JSON.stringify(parsed.raw), payment.id);
  return res.json({ received: true, reference: parsed.reference, paymentStatus: status });
}

router.post('/api/webhooks/paystack', async (req, res) => {
  const event = JSON.parse(rawBodyOf(req) || '{}').event;
  if (event && !event.startsWith('charge.')) {
    return res.json({ received: true, ignored: event });
  }
  return receive(paystack, req, res);
});

router.post('/api/webhooks/mtn-momo', (req, res) => receive(mtnMomo, req, res));

export default router;
