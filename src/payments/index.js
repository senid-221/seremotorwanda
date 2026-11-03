import crypto from 'node:crypto';
import { config } from '../config.js';
import { ApiError } from '../validate.js';
import { paystack } from './paystack.js';
import { mtnMomo } from './mtnMomo.js';

const providers = new Map([[paystack.id, paystack], [mtnMomo.id, mtnMomo]]);

export const getProvider = (id) => {
  const provider = providers.get(String(id || ''));
  if (!provider) {
    throw new ApiError(422, 'unknown_provider', `provider must be one of: ${[...providers.keys()].join(', ')}`);
  }
  return provider;
};

export const newReference = (providerId) =>
  `SM-${providerId.slice(0, 4).toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

export function splitFare(amountRwf) {
  const platformFee = Math.min(amountRwf, Math.round((amountRwf * config.commissionPercent) / 100));
  return { amountRwf, platformFee, driverPayout: amountRwf - platformFee };
}

export function providerHealth() {
  const { baseUrl, userId, subscriptionKey, primaryKey, apiKey } = config.momo;
  return {
    paystack: Boolean(config.paystack.secretKey),
    mtn_momo: Boolean(baseUrl && userId && subscriptionKey && primaryKey && apiKey),
  };
}
