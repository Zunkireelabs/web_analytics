// Tests for the post-publish rebuild trigger.
//
// Two things matter here beyond "does it fire": that it SIGNS the request the
// way the receiver verifies (the receiver used to accept unsigned triggers and
// no longer does), and that it never reports a rebuild it didn't actually get
// accepted — a published document that isn't live yet is a normal state, but
// claiming otherwise would hide it.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { rebuildConfig, triggerCmsRebuild } from './rebuild.js';

const SECRET_VAR = 'TEST_REBUILD_SECRET';
const SECRET = 'test-rebuild-secret';

const siteWith = (siteRoot) => ({ id: 7, url_file_map: { siteRoot } });
const CONFIGURED = siteWith({ cmsRebuildWebhookUrl: 'https://example.test/webhook', cmsRebuildSecretEnvVar: SECRET_VAR });

let realFetch;
let lastRequest;

beforeEach(() => {
  realFetch = globalThis.fetch;
  lastRequest = null;
  process.env[SECRET_VAR] = SECRET;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env[SECRET_VAR];
});

function stubFetch({ ok = true, status = 200, body = '' } = {}) {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url, init };
    return { ok, status, text: async () => body };
  };
}

describe('configuration', () => {
  test('reads the per-site config out of url_file_map.siteRoot', () => {
    assert.deepEqual(rebuildConfig(CONFIGURED), { url: 'https://example.test/webhook', secretEnvVar: SECRET_VAR });
  });

  test('a site with no rebuild configured reports it, without erroring', async () => {
    // Not a failure: the content IS published, and a later build carries it
    // live. Only claiming a rebuild happened would be wrong.
    const result = await triggerCmsRebuild(siteWith({}));
    assert.equal(result.triggered, false);
    assert.equal(result.reason, 'no-rebuild-webhook-configured');
  });

  test('a configured site whose secret env var is unset fails closed and names the variable', async () => {
    delete process.env[SECRET_VAR];
    const result = await triggerCmsRebuild(CONFIGURED);
    assert.equal(result.triggered, false);
    assert.equal(result.reason, 'rebuild-secret-missing');
    assert.match(result.error, new RegExp(SECRET_VAR));
  });

  test('never sends an unsigned request when no secret is configured', async () => {
    stubFetch();
    await triggerCmsRebuild(siteWith({ cmsRebuildWebhookUrl: 'https://example.test/webhook' }));
    assert.equal(lastRequest, null, 'must not call the webhook at all without a secret to sign with');
  });
});

describe('signing', () => {
  test('sends a signature the receiver will accept, over "<timestamp>.<body>"', async () => {
    stubFetch();
    const result = await triggerCmsRebuild(CONFIGURED);
    assert.equal(result.triggered, true);

    const header = lastRequest.init.headers['sanity-webhook-signature'];
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2)));
    assert.ok(parts.t, 'must carry a timestamp');
    assert.ok(parts.v1, 'must carry a digest');

    // Recompute exactly as the receiver does.
    const expected = createHmac('sha256', SECRET).update(`${parts.t}.${lastRequest.init.body}`).digest('hex');
    assert.equal(parts.v1, expected, 'digest must verify against the same secret and payload');
  });

  test('the timestamp is current, so the receiver\'s freshness window accepts it', async () => {
    stubFetch();
    await triggerCmsRebuild(CONFIGURED);
    const parts = Object.fromEntries(lastRequest.init.headers['sanity-webhook-signature'].split(',').map((p) => p.split('=', 2)));
    const age = Math.abs(Date.now() / 1000 - Number(parts.t));
    assert.ok(age < 60, `timestamp should be fresh, was ${age}s old`);
  });

  test('signs with THIS site\'s secret — a different site\'s secret must not verify', async () => {
    stubFetch();
    await triggerCmsRebuild(CONFIGURED);
    const parts = Object.fromEntries(lastRequest.init.headers['sanity-webhook-signature'].split(',').map((p) => p.split('=', 2)));
    const otherTenant = createHmac('sha256', 'a-different-tenants-secret').update(`${parts.t}.${lastRequest.init.body}`).digest('hex');
    assert.notEqual(parts.v1, otherTenant);
  });
});

describe('outcome reporting', () => {
  test('a non-2xx response is reported as not triggered, with the status', async () => {
    stubFetch({ ok: false, status: 401, body: 'Invalid signature' });
    const result = await triggerCmsRebuild(CONFIGURED);
    assert.equal(result.triggered, false);
    assert.equal(result.reason, 'rebuild-request-failed');
    assert.match(result.error, /401/);
  });

  test('a network failure is reported honestly rather than swallowed', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const result = await triggerCmsRebuild(CONFIGURED);
    assert.equal(result.triggered, false);
    assert.match(result.error, /ECONNREFUSED/);
  });

  test('success reports acceptance, not that the content is live', async () => {
    // The receiver queues the build and responds immediately; whether the
    // build then succeeded is not known here and must not be implied.
    stubFetch();
    const result = await triggerCmsRebuild(CONFIGURED);
    assert.equal(result.triggered, true);
    assert.ok(result.acceptedAt);
    assert.equal(result.live, undefined);
    assert.equal(result.published, undefined);
  });
});
