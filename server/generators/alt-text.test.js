import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { meta, generate } from './alt-text.js';

function stubFetchHtml(html) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => html,
    url,
  });
  return () => { globalThis.fetch = original; };
}

describe('alt-text generator', () => {
  test('requires page', async () => {
    await assert.rejects(() => generate({ siteId: 1, params: {} }));
  });

  test('refuses when the page has no images missing alt text', async () => {
    const restore = stubFetchHtml('<html><head><title>T</title></head><body><img src="/a.jpg" alt="Already described"></body></html>');
    try {
      await assert.rejects(
        () => generate({ siteId: 1, params: { page: 'https://example.com/x' } }),
        /no images missing alt text/i,
      );
    } finally { restore(); }
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'alt-text');
  });
});
