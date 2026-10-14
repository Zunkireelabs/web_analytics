import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let headersImpl;
mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: { fetchResponseHeaders: async (url) => headersImpl(url) },
});

const { generate, meta, verifyCurrentState } = await import('./security-headers.js');

describe('security-headers generator', () => {
  test('emits only the requested headers, in a stable order', async () => {
    const { content } = await generate({ params: { missingHeaders: ['referrer-policy', 'x-frame-options'] } });
    assert.deepEqual(content.headersIncluded, ['x-frame-options', 'referrer-policy']);
    assert.match(content.nginxBlock, /X-Frame-Options "SAMEORIGIN" always;/);
    assert.match(content.nginxBlock, /Referrer-Policy "strict-origin-when-cross-origin" always;/);
    assert.doesNotMatch(content.nginxBlock, /X-Content-Type-Options/);
    assert.doesNotMatch(content.nginxBlock, /Strict-Transport-Security/);
    assert.doesNotMatch(content.nginxBlock, /Content-Security-Policy/);
  });

  test('falls back to all five headers when missingHeaders is absent', async () => {
    const { content } = await generate({ params: {} });
    assert.equal(content.headersIncluded.length, 5);
  });

  test('falls back to all five headers when missingHeaders is empty', async () => {
    const { content } = await generate({ params: { missingHeaders: [] } });
    assert.equal(content.headersIncluded.length, 5);
  });

  test('ignores an unrecognized header key rather than emitting garbage', async () => {
    const { content } = await generate({ params: { missingHeaders: ['x-frame-options', 'not-a-real-header'] } });
    assert.deepEqual(content.headersIncluded, ['x-frame-options']);
  });

  test('CSP is Report-Only, never enforcing', async () => {
    const { content } = await generate({ params: { missingHeaders: ['content-security-policy'] } });
    assert.match(content.nginxBlock, /Content-Security-Policy-Report-Only/);
    assert.doesNotMatch(content.nginxBlock, /add_header Content-Security-Policy /);
  });

  test('HSTS includes includeSubDomains but never preload', async () => {
    const { content } = await generate({ params: { missingHeaders: ['strict-transport-security'] } });
    assert.match(content.nginxBlock, /includeSubDomains/);
    assert.doesNotMatch(content.nginxBlock, /preload/);
  });

  test('every directive uses `always` so headers survive error/redirect responses', async () => {
    const { content } = await generate({ params: {} });
    const lines = content.nginxBlock.split('\n');
    assert.equal(lines.length, 5);
    for (const line of lines) assert.match(line, /always;$/);
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'security-headers');
  });
});

describe('security-headers verifyCurrentState (server/generators/lib/verification-layer.js contract)', () => {
  const site = { id: 1, website_domain: 'example.com' };
  const rec = { params: { missingHeaders: ['x-frame-options', 'referrer-policy'] } };

  test('no site context: still_valid without guessing', async () => {
    const result = await verifyCurrentState(rec, {});
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'no-site-context');
  });

  test('every named header now present: already_resolved', async () => {
    headersImpl = async () => ({ ok: true, headers: new Map([['x-frame-options', 'SAMEORIGIN'], ['referrer-policy', 'strict-origin-when-cross-origin']]) });
    const result = await verifyCurrentState(rec, { site });
    assert.equal(result.decision, 'already_resolved');
  });

  test('one named header still missing: still_valid', async () => {
    headersImpl = async () => ({ ok: true, headers: new Map([['x-frame-options', 'SAMEORIGIN']]) });
    const result = await verifyCurrentState(rec, { site });
    assert.equal(result.decision, 'still_valid');
    assert.deepEqual(result.evidence.stillMissing, ['referrer-policy']);
  });

  test('unreachable: still_valid, not a guess either way', async () => {
    headersImpl = async () => ({ ok: false, error: 'timeout' });
    const result = await verifyCurrentState(rec, { site });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'unreachable');
  });
});
