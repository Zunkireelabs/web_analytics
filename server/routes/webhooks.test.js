import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import router, { verifyWithSecret } from './webhooks.js';

// This repo has no supertest/nock convention (see
// action-center-safe-fix-batch.test.js's own note), so route registration
// is asserted against the router's real stack, and signature verification —
// the one piece of this file with no DB/network dependency — is unit-tested
// directly instead of driving real HTTP.

describe('webhook routes registered', () => {
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);

  test('the per-repo PR webhook is registered', () => {
    assert.ok(paths.includes('/webhooks/github'));
  });

  test('the GitHub App installation webhook is registered separately', () => {
    assert.ok(paths.includes('/webhooks/github-app'));
  });
});

describe('verifyWithSecret', () => {
  const secret = 'test-secret';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const validSig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  test('accepts a signature computed with the matching secret', () => {
    assert.equal(verifyWithSecret(secret, body, validSig), true);
  });

  test('rejects a signature computed with a different secret', () => {
    const wrongSig = `sha256=${createHmac('sha256', 'wrong-secret').update(body).digest('hex')}`;
    assert.equal(verifyWithSecret(secret, body, wrongSig), false);
  });

  test('rejects a tampered body', () => {
    const tampered = Buffer.from(JSON.stringify({ hello: 'tampered' }));
    assert.equal(verifyWithSecret(secret, tampered, validSig), false);
  });

  test('fails closed when no secret is configured', () => {
    assert.equal(verifyWithSecret(undefined, body, validSig), false);
    assert.equal(verifyWithSecret('', body, validSig), false);
  });

  test('fails closed when no signature header is present', () => {
    assert.equal(verifyWithSecret(secret, body, undefined), false);
  });

  // The two webhook flavors (per-repo vs GitHub App) use the same HMAC
  // check but must never accept each other's secret — this is what keeps a
  // leaked repo-webhook secret from being usable to forge an installation
  // event, and vice versa. Not a bug in verifyWithSecret itself (it only
  // ever sees one secret at a time), but the property the two-secret split
  // in webhooks.js depends on: a signature made with secret A must not
  // verify against secret B.
  test('a signature made with one secret does not verify against a different one', () => {
    const appSecret = 'app-secret';
    const repoSig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    assert.equal(verifyWithSecret(appSecret, body, repoSig), false);
  });
});
