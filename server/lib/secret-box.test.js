import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret, secretBoxConfigured } from './secret-box.js';

const was = process.env.SECRETS_ENCRYPTION_KEY;
beforeEach(() => { process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64'); });
afterEach(() => { if (was === undefined) delete process.env.SECRETS_ENCRYPTION_KEY; else process.env.SECRETS_ENCRYPTION_KEY = was; });

describe('secret-box', () => {
  test('a secret round-trips, and the stored form never contains it', () => {
    const token = '1//0gExampleRefreshToken-abc_123';
    const stored = encryptSecret(token);
    assert.equal(stored.includes(token), false);
    assert.match(stored, /^v1:/);
    assert.equal(decryptSecret(stored), token);
  });

  test('the same secret encrypts differently every time (fresh IV)', () => {
    assert.notEqual(encryptSecret('same'), encryptSecret('same'));
  });

  test('a changed stored value fails to decrypt instead of returning something', () => {
    const parts = encryptSecret('secret-value').split(':');
    parts[3] = Buffer.from('tampered-ciphertext').toString('base64url');
    assert.throws(() => decryptSecret(parts.join(':')));
  });

  test('a different key cannot read it', () => {
    const stored = encryptSecret('secret-value');
    process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    assert.throws(() => decryptSecret(stored));
  });

  test('with no key, or a key of the wrong length, it refuses — there is no fallback key', () => {
    delete process.env.SECRETS_ENCRYPTION_KEY;
    assert.equal(secretBoxConfigured(), false);
    assert.throws(() => encryptSecret('x'), /SECRETS_ENCRYPTION_KEY/);
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.from('too short').toString('base64');
    assert.equal(secretBoxConfigured(), false);
    assert.throws(() => encryptSecret('x'), /32 bytes/);
  });

  test('refuses to encrypt nothing, and does not recognise an unknown format', () => {
    assert.throws(() => encryptSecret(''));
    assert.throws(() => encryptSecret(null));
    assert.throws(() => decryptSecret('v9:a:b:c'));
    assert.throws(() => decryptSecret('plain text'));
  });
});
