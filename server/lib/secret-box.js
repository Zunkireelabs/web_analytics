import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Reversible encryption for the few secrets this app must be able to READ BACK
// (today: a project's Google refresh token). Everything else it stores as a hash,
// because it only ever needs to compare; a refresh token has to be presented to
// Google, so it has to be recoverable — which is exactly why it must not sit in the
// database in the clear.
//
// AES-256-GCM with a fresh random IV per value. GCM authenticates as well as
// encrypts, so a stored value that was altered fails to decrypt instead of yielding
// garbage. The key is SECRETS_ENCRYPTION_KEY: 32 random bytes, base64. There is
// deliberately NO fallback key and no "dev default": without a valid key this
// module refuses to encrypt or decrypt, so a mis-configured deploy fails loudly
// instead of silently storing tokens under a key everyone can read in the repo.
//
// Stored form:  v1:<iv>:<tag>:<ciphertext>   (each part base64url). The version prefix
// leaves room to change the scheme later without guessing what an old row used.
const VERSION = 'v1';

export function secretBoxConfigured() {
  try { keyFromEnv(); return true; } catch { return false; }
}

function keyFromEnv() {
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) throw new Error('SECRETS_ENCRYPTION_KEY is not set.');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('SECRETS_ENCRYPTION_KEY must be 32 bytes, base64 encoded.');
  return key;
}

export function encryptSecret(plain) {
  if (typeof plain !== 'string' || !plain) throw new Error('Nothing to encrypt.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromEnv(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(':');
}

export function decryptSecret(stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unrecognised secret format.');
  const [, iv, tag, body] = parts;
  const decipher = createDecipheriv('aes-256-gcm', keyFromEnv(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
