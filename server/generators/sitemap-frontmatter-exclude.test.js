import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './sitemap-frontmatter-exclude.js';

describe('sitemap-frontmatter-exclude generator', () => {
  test('meta.id matches the risk-tiers/severity-tiers/backend.js wiring', () => {
    assert.equal(meta.id, 'sitemap-frontmatter-exclude');
  });

  test('requires both page and field', async () => {
    await assert.rejects(() => generate({ params: {} }));
    await assert.rejects(() => generate({ params: { page: 'https://example.com/a/' } }));
    await assert.rejects(() => generate({ params: { field: 'excludeFromSitemap' } }));
  });

  test('returns the page and field as content — the real work happens at apply time', async () => {
    const draft = await generate({ params: { page: 'https://example.com/a/', field: 'excludeFromSitemap' } });
    assert.deepEqual(draft.content, { page: 'https://example.com/a/', field: 'excludeFromSitemap' });
    assert.match(draft.summary, /excludeFromSitemap: true/);
  });
});
