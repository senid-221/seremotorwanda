/* SERE Moto — the credential lookups the signup page calls before an application is filed.
   Both routes are fenced behind a verify_token, i.e. a phone number that just proved it owns
   itself with a real SMS code, so nobody can drive RRA or NIDA from a script. A lookup that
   finds nothing answers 200 with valid:false — it succeeded, the number is simply not in the
   register — while a lookup that could not be made at all answers 502/503 so the page can say
   "we could not check" instead of "you are wrong". */
import { Router } from 'express';
import { verifyToken } from '../auth.js';
import { ApiError, idNumber, text, tinNumber } from '../validate.js';
import { verifyId, verifyTin } from '../kyc.js';

const router = Router();

function verifiedPhone(rawToken) {
  const claims = verifyToken(rawToken);
  if (!claims || !claims.phoneVerified) {
    throw new ApiError(400, 'invalid_verify_token', 'Verify the phone number by SMS before checking credentials.');
  }
  return claims.phoneVerified;
}

router.post('/api/verify-tin', async (req, res) => {
  const phone = verifiedPhone(req.body.verify_token);
  const tin = tinNumber(req.body.tin_number ?? req.body.tin);
  const result = await verifyTin(tin, { phone, force: req.body.force === true || req.body.force === '1' });
  res.json({ valid: result.valid, taxpayer: result.taxpayer || null, source: result.source });
});

/* The register's own spelling of the name is deliberately not echoed back: a caller who can
   post any 16-digit number would otherwise read the civil register one match at a time. */
router.post('/api/verify-id', async (req, res) => {
  const phone = verifiedPhone(req.body.verify_token);
  const number = idNumber(req.body.id_number);
  const names = req.body.names ? text(req.body.names, 'names', { min: 3, max: 80 }) : null;
  const result = await verifyId(number, names, { phone, force: req.body.force === true || req.body.force === '1' });
  res.json({ exists: result.exists, match: result.match, source: result.source });
});

export default router;
