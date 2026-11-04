/* SERE Moto — the credential lookups the details form calls while a rider is filling it in.
   Both routes are fenced behind the rider's own session: nobody can drive RRA or NIDA straight from
   a script, and the cost budget is spent per account rather than per phone number. A session says
   who is asking, it does not say they are telling the truth about themselves — that is what the
   register's answer is for. A lookup that finds nothing answers 200 with valid:false — it succeeded,
   the number is simply not in the register — while a lookup that could not be made at all answers
   502/503 so the page can say "we could not check" instead of "you are wrong". */
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { idNumber, text, tinNumber } from '../validate.js';
import { verifyId, verifyTin } from '../kyc.js';

const router = Router();

/* Only a rider who has created an account is allowed to ask, and their account id is the key the
   lookup budget is counted against — the same id the application will be filed under. */
const askAs = (req) => `driver:${req.driverId}`;

router.post('/api/verify-tin', requireAuth, async (req, res) => {
  const tin = tinNumber(req.body.tin_number ?? req.body.tin);
  const result = await verifyTin(tin, { key: askAs(req), force: req.body.force === true || req.body.force === '1' });
  res.json({ valid: result.valid, taxpayer: result.taxpayer || null, source: result.source });
});

/* The register's own spelling of the name is deliberately not echoed back: a caller who can
   post any 16-digit number would otherwise read the civil register one match at a time. */
router.post('/api/verify-id', requireAuth, async (req, res) => {
  const number = idNumber(req.body.id_number);
  const names = req.body.names ? text(req.body.names, 'names', { min: 3, max: 80 }) : null;
  const result = await verifyId(number, names, { key: askAs(req), force: req.body.force === true || req.body.force === '1' });
  res.json({ exists: result.exists, match: result.match, source: result.source });
});

export default router;
