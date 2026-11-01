import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'eta_session';
export const SESSION_HOURS = 12;

const KEY_LENGTH = 64;

// Stored as "salt.hash", so the real password is never kept anywhere.
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `${salt}.${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split('.');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== KEY_LENGTH) return false;
  return timingSafeEqual(scryptSync(password, salt, KEY_LENGTH), expected);
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

// A session is an expiry time plus a signature, so it can't be forged or
// extended without the server's secret.
export function createSession(secret: string, now = Date.now()): string {
  const expires = String(now + SESSION_HOURS * 60 * 60 * 1000);
  return `${expires}.${sign(expires, secret)}`;
}

export function isValidSession(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const [expires, signature] = token.split('.');
  if (!expires || !signature) return false;
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(expires, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  return Number(expires) > now;
}
