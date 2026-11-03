export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (field, message) => {
  throw new ApiError(422, `invalid_${field}`, message);
};

/* The three digit counts every KYC form and error message quotes. /api/config publishes them
   so the frontend validates the same numbers instead of carrying its own copy. */
export const KYC_RULES = { phoneDigits: 10, idDigits: 16, tinDigits: 9 };

const exactlyDigits = (count) => new RegExp(`^\\d{${count}}$`);

export function normalizeRwandaPhone(raw, field = 'phone') {
  let digits = String(raw || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('00250')) digits = digits.slice(5);
  else if (digits.startsWith('250')) digits = digits.slice(3);
  if (!/^07[2-9]\d{7}$/.test(digits)) {
    fail(field, `Phone must be the ${KYC_RULES.phoneDigits} digits of a Rwandan mobile number such as 0788123456`);
  }
  return digits;
}

export const toInternational = (local) => `250${local.slice(1)}`;

export function normalizePlate(raw) {
  const value = String(raw || '').trim().toUpperCase().replace(/[\s_-]+/g, ' ').replace(/\s+([0-9])/, ' $1').trim();
  if (!/^[A-Z]{2,3} ?[0-9]{2,4} ?[A-Z]?$/.test(value.replace(/ /g, '')) && !/^[A-Z]{2,3} [0-9]{2,4} [A-Z]$/.test(value)) {
    fail('plate', 'Plate must look like RAB 123 A');
  }
  return value;
}

export function text(raw, field, { min = 1, max = 200 } = {}) {
  const value = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (value.length < min) fail(field, `${field} is required`);
  if (value.length > max) fail(field, `${field} must be at most ${max} characters`);
  return value;
}

export function oneOf(raw, allowed, field) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!allowed.includes(value)) fail(field, `${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function integerInRange(raw, field, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(field, `${field} must be a whole number between ${min} and ${max}`);
  }
  return value;
}

export function numberInRange(raw, field, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    fail(field, `${field} must be a number between ${min} and ${max}`);
  }
  return value;
}

export const latitude = (raw, field = 'lat') => numberInRange(raw, field, -90, 90);

export const longitude = (raw, field = 'lng') => numberInRange(raw, field, -180, 180);

/* "lat,lng" straight from the browser's geolocation — decides which of the three Remeras is meant. */
export function parseNear(raw) {
  const [lat, lng] = String(raw || '').split(',').map((v) => Number(String(v).trim()));
  return { lat: latitude(lat, 'near'), lng: longitude(lng, 'near') };
}

/* The two languages the app speaks. Anything else is English, never a 422: a browser can send a
   stray Accept-Language or a hand-typed ?lang=fr and the page still has to render. */
export const language = (raw) => (String(raw || '').toLowerCase().startsWith('rw') ? 'rw' : 'en');

/* A division code as it is stored: lowercase slug path, up to 70 characters. Existence is checked
   by the caller because only the division module can answer that. */
export function divisionCode(raw, field = 'location_code') {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) fail(field, `${field} is required`);
  if (value.length > 70) fail(field, `${field} must be at most 70 characters`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) {
    fail(field, `${field} must be a division code like kigali-city-gasabo, in lowercase letters, digits and hyphens`);
  }
  return value;
}

export const queryOrBody = (req, name) => (req.query[name] !== undefined ? req.query[name] : req.body?.[name]);

export function stringList(raw, field, { max = 12 } = {}) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const cleaned = [...new Set(list.map((v) => text(v, field, { max: 60 })).filter(Boolean))];
  if (cleaned.length > max) fail(field, `${field} accepts at most ${max} values`);
  return cleaned;
}

export function email(raw) {
  const value = String(raw || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) fail('email', 'A valid email is required for card payments');
  return value;
}

export const STATUS_FLOW = {
  new: ['seen', 'accepted', 'declined', 'cancelled'],
  seen: ['accepted', 'declined', 'cancelled'],
  accepted: ['completed', 'cancelled'],
  completed: [],
  declined: [],
  cancelled: [],
};

export function assertTransition(from, to) {
  const allowed = STATUS_FLOW[from] || [];
  if (!allowed.includes(to)) {
    throw new ApiError(409, 'invalid_status_change', `Cannot move a request from ${from} to ${to}`);
  }
}

export function idNumber(raw) {
  const value = String(raw || '').replace(/[\s-]/g, '');
  if (!exactlyDigits(KYC_RULES.idDigits).test(value)) {
    fail('id_number', `National ID must be the ${KYC_RULES.idDigits} digits on the Rwandan ID card`);
  }
  return value;
}

/* A RRA taxpayer number is exactly 9 digits — the 10 and 11 digit forms are business VAT numbers,
   not the TIN a moto rider is issued, and they never match /customers/selectCustomer. */
export function tinNumber(raw) {
  const value = String(raw || '').replace(/[\s-]/g, '');
  if (!exactlyDigits(KYC_RULES.tinDigits).test(value)) {
    fail('tin_number', `TIN must be the ${KYC_RULES.tinDigits} digits printed on your RRA taxpayer certificate`);
  }
  return value;
}

export function otpCode(raw) {
  const value = String(raw || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(value)) fail('code', 'Enter the 6-digit code');
  return value;
}

export const roundTo = (value, step) => Math.max(step, Math.round(value / step) * step);
