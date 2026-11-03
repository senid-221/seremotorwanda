import crypto from 'node:crypto';
import { config, otpDevMode } from './config.js';
import { get, run } from './db.js';
import { ApiError } from './validate.js';
import { hashCode, matchesHash } from './auth.js';
import { sendSms } from './sms.js';

const newCode = () => String(crypto.randomInt(100_000, 1_000_000));

export async function sendOtp(phone) {
  const { ttlSeconds, resendSeconds, maxPerHour } = config.otp;
  const recent = (await get(
    `SELECT COUNT(*) AS count FROM otp_challenges
     WHERE phone = ? AND created_at > datetime('now', '-1 hour')`,
    phone,
  )).count;
  if (recent >= maxPerHour) {
    throw new ApiError(429, 'otp_rate_limited', 'Too many codes requested for this phone. Try again later.');
  }
  const live = await get(
    `SELECT created_at FROM otp_challenges
     WHERE phone = ? AND consumed_at IS NULL AND expires_at > datetime('now')
     ORDER BY id DESC LIMIT 1`,
    phone,
  );
  if (live) {
    const waited = Math.floor((Date.now() - Date.parse(`${live.created_at} UTC`)) / 1000);
    const retryAfter = resendSeconds - waited;
    if (retryAfter > 0) {
      throw new ApiError(429, 'otp_rate_limited', `Wait ${retryAfter}s before requesting another code.`);
    }
  }

  const code = newCode();
  const challenge = await run(
    `INSERT INTO otp_challenges (phone, code_hash, expires_at)
     VALUES (?, ?, datetime('now', '+${ttlSeconds} seconds')) RETURNING id`,
    phone, hashCode(code),
  );

  const message = `SERE Moto: ${code} — verification code, valid ${Math.round(ttlSeconds / 60)} minutes.`;

  /* With no aggregator configured the code goes to the server console, and OTP_ECHO is what
     lets the test suite sign in. Once a provider IS configured the code never leaves this
     process again — not in the console, and above all not in the API response. */
  if (otpDevMode()) {
    console.log(`[seremoto] OTP for ${phone}: ${code} (no SMS provider configured)`);
    return { sent: true, ttlSeconds, ...(config.otpEcho ? { devCode: code } : {}) };
  }

  const { provider, ref } = await sendSms(phone, message);
  await run('UPDATE otp_challenges SET provider = ?, sms_ref = ? WHERE id = ?', provider, ref, challenge.lastInsertRowid);
  return { sent: true, ttlSeconds };
}

export async function consumeOtp(phone, code) {
  const challenge = await get(
    `SELECT * FROM otp_challenges
     WHERE phone = ? AND consumed_at IS NULL AND expires_at > datetime('now')
     ORDER BY id DESC LIMIT 1`,
    phone,
  );
  if (!challenge) {
    throw new ApiError(410, 'otp_expired', 'That code has expired or was already used. Request a new one.');
  }
  if (challenge.attempts >= config.otp.maxAttempts) {
    await run('UPDATE otp_challenges SET consumed_at = datetime(\'now\') WHERE id = ?', challenge.id);
    throw new ApiError(429, 'otp_attempts_exceeded', 'Too many wrong attempts. Request a new code.');
  }
  if (!matchesHash(code, challenge.code_hash)) {
    await run('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?', challenge.id);
    throw new ApiError(401, 'otp_invalid', 'That code is not correct.');
  }
  await run('UPDATE otp_challenges SET consumed_at = datetime(\'now\') WHERE id = ?', challenge.id);
}
