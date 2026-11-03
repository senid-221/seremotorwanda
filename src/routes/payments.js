import { Router } from 'express';
import { all, get, run } from '../db.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { ApiError, email as validEmail, integerInRange, normalizeRwandaPhone, toInternational } from '../validate.js';
import { getProvider, newReference, splitFare } from '../payments/index.js';

const router = Router();
const PAYABLE = ['accepted', 'completed'];

export function shapePayment(row) {
  return {
    id: row.id,
    requestId: row.request_id,
    provider: row.provider,
    reference: row.provider_reference,
    amountRwf: row.amount_rwf,
    platformFeeRwf: row.platform_fee_rwf,
    driverPayoutRwf: row.driver_payout_rwf,
    status: row.status,
    checkoutUrl: row.checkout_url,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
  };
}

const ownedRequest = async (req, id) => {
  const row = await get('SELECT * FROM ride_requests WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'request_not_found', 'No such request');
  if (row.driver_id !== req.driverId) throw new ApiError(403, 'forbidden', 'This request belongs to another driver');
  return row;
};

router.post('/api/requests/:id/payments', async (req, res) => {
  const requestId = integerInRange(req.params.id, 'id', 1, 1e9);
  const provider = getProvider(req.body.provider);
  const request = await get('SELECT * FROM ride_requests WHERE id = ?', requestId);
  if (!request) throw new ApiError(404, 'request_not_found', 'No such request');
  if (!PAYABLE.includes(request.status)) {
    throw new ApiError(409, 'not_payable', `Only accepted or completed trips can be paid (this one is ${request.status})`);
  }

  const existing = await get(
    "SELECT * FROM payments WHERE request_id = ? AND provider = ? AND status = 'pending'",
    requestId, provider.id,
  );
  if (existing) {
    return res.status(200).json({ payment: shapePayment(existing), reused: true });
  }

  const amount = request.fare_rwf || integerInRange(req.body.amount_rwf, 'amount_rwf', 100, 500000);
  const payer = { phone: null, email: null };
  if (provider.id === 'mtn_momo') {
    payer.phone = toInternational(normalizeRwandaPhone(req.body.phone || request.client_phone, 'phone'));
  } else {
    payer.email = validEmail(req.body.email);
  }

  const { platformFee, driverPayout } = splitFare(amount);
  const reference = newReference(provider.id);
  const result = await run(
    `INSERT INTO payments (request_id, provider, provider_reference, payer_phone, payer_email, amount_rwf, platform_fee_rwf, driver_payout_rwf)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    requestId, provider.id, reference, payer.phone, payer.email, amount, platformFee, driverPayout,
  );

  let initiated;
  try {
    initiated = await provider.initiate({
      reference,
      amountRwf: amount,
      payer,
      description: `SERE Moto ${request.kind} ${request.origin}-${request.destination} #${request.id}`,
    });
  } catch (error) {
    /* The row already exists, so it is closed as failed rather than left pending forever. */
    await run("UPDATE payments SET status = 'failed', confirm_response = ? WHERE id = ?",
      JSON.stringify({ error: String(error.message || error) }), result.lastInsertRowid);
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'provider_unreachable', `${provider.id} could not be reached: ${error.message}`);
  }
  await run(
    'UPDATE payments SET checkout_url = ?, initiate_response = ? WHERE id = ?',
    initiated.checkoutUrl, JSON.stringify(initiated.raw), result.lastInsertRowid,
  );
  res.status(201).json({
    payment: shapePayment(await get('SELECT * FROM payments WHERE id = ?', result.lastInsertRowid)),
    commissionPercent: config.commissionPercent,
  });
});

router.get('/api/payments/:reference', requireAuth, async (req, res) => {
  const row = await get('SELECT * FROM payments WHERE provider_reference = ?', req.params.reference);
  if (!row) throw new ApiError(404, 'payment_not_found', 'No such payment');
  await ownedRequest(req, row.request_id);
  res.json({ payment: shapePayment(row) });
});

router.post('/api/payments/:reference/verify', requireAuth, async (req, res) => {
  const row = await get('SELECT * FROM payments WHERE provider_reference = ?', req.params.reference);
  if (!row) throw new ApiError(404, 'payment_not_found', 'No such payment');
  await ownedRequest(req, row.request_id);
  const provider = getProvider(row.provider);
  let checked;
  try {
    checked = await provider.verify(row.provider_reference);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'provider_unreachable', `${provider.id} could not be reached: ${error.message}`);
  }
  if (checked.paid && row.status !== 'paid') {
    await run("UPDATE payments SET status = 'paid', confirm_response = ?, confirmed_at = datetime('now') WHERE id = ?",
      JSON.stringify(checked.raw), row.id);
  } else if (!checked.paid && ['failed', 'cancelled'].includes(checked.status)) {
    await run("UPDATE payments SET status = 'failed', confirm_response = ? WHERE id = ?", JSON.stringify(checked.raw), row.id);
  }
  res.json({ payment: shapePayment(await get('SELECT * FROM payments WHERE id = ?', row.id)) });
});

router.get('/api/earnings', requireAuth, async (req, res) => {
  const totals = await get(
    `SELECT COUNT(*) AS payments,
            COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount_rwf END), 0)        AS collected_rwf,
            COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.driver_payout_rwf END), 0) AS payout_rwf,
            COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.platform_fee_rwf END), 0)  AS fee_rwf
       FROM payments p JOIN ride_requests r ON r.id = p.request_id
      WHERE r.driver_id = ?`,
    req.driverId,
  );
  res.json({
    commissionPercent: config.commissionPercent,
    ...totals,
    byProvider: await all(
      `SELECT p.provider, p.status, COUNT(*) AS count
         FROM payments p JOIN ride_requests r ON r.id = p.request_id
        WHERE r.driver_id = ? GROUP BY p.provider, p.status`,
      req.driverId,
    ),
  });
});

export const recordWebhook = async ({ provider, reference, payload, error = null }) => {
  try {
    await run('INSERT INTO webhook_events (provider, external_id, payload, error) VALUES (?, ?, ?, ?)',
      provider, String(reference ?? ''), JSON.stringify(payload ?? {}), error);
  } catch (duplicate) {
    if (duplicate.code !== '23505') throw duplicate;
    return false;
  }
  return true;
};

export default router;
