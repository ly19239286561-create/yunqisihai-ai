import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const SCRYPT_COST = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value.length > 254 || value.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

export function validPassword(value) {
  return typeof value === 'string' && value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX;
}

export function normalizeName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

export async function hashPassword(password) {
  if (!validPassword(password)) throw new Error('密码长度应为12至128位');
  const salt = crypto.randomBytes(24);
  const key = await scrypt(password, salt, 64, SCRYPT_COST);
  return ['scrypt', salt.toString('hex'), key.toString('hex')].join(':');
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > PASSWORD_MAX || typeof encoded !== 'string') return false;
  const [scheme, saltHex, hashHex, tail] = encoded.split(':');
  if (scheme !== 'scrypt' || tail !== undefined || !/^[0-9a-f]{48}$/.test(saltHex || '') || !/^[0-9a-f]{128}$/.test(hashHex || '')) return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64, SCRYPT_COST);
  const expected = Buffer.from(hashHex, 'hex');
  return crypto.timingSafeEqual(key, expected);
}

export function digestToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
