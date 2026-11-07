import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { normalizeEmail, normalizeName, validPassword, hashPassword, verifyPassword, digestToken } from './member-security.js';

test('normalize and reject malformed email addresses', () => {
  assert.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
  assert.equal(normalizeEmail('x@'), null);
  assert.equal(normalizeEmail(42), null);
});
test('validate strong password size and profile name', () => {
  assert.equal(validPassword('test123'), false);
  assert.equal(validPassword('12orMoreCharacter$'), true);
  assert.equal(normalizeName('  张家界导游 '), '张家界导游');
  assert.equal(normalizeName('\n'), null);
});
test('scrypt hash verifies password and does not reveal it', async () => {
  const password = 'test-strong-2026!';
  const encoded = await hashPassword(password);
  assert.equal(encoded.includes(password),false);
  assert.equal(await verifyPassword(password,encoded),true);
  assert.equal(await verifyPassword('wrong-password',encoded),false);
  assert.equal(await verifyPassword('test', 'nonsense'),false);
});
test('sessions use nonreversible token hashes', () => {
  const token = crypto.randomBytes(32).toString('hex');
  assert.equal(digestToken(token).length,64);
  assert.notEqual(digestToken(token),token);
});
