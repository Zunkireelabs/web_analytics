import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './security-headers.js';

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
