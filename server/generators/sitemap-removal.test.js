import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './sitemap-removal.js';

describe('sitemap-removal generator', () => {
  test('meta.id matches the risk-tiers/severity-tiers/coordinator wiring', () => {
    assert.equal(meta.id, 'sitemap-removal');
  });

  test('requires a non-empty removeUrls array', async () => {
    await assert.rejects(() => generate({ params: {} }));
    await assert.rejects(() => generate({ params: { removeUrls: [] } }));
  });

  test('returns the requested URLs as content — the real work happens at apply time', async () => {
    const draft = await generate({ params: { removeUrls: ['https://example.com/blocked/'] } });
    assert.deepEqual(draft.content, { removeUrls: ['https://example.com/blocked/'] });
    assert.match(draft.summary, /Remove 1 URL/);
  });
});
