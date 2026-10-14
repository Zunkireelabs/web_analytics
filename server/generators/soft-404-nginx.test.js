import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './soft-404-nginx.js';

test('meta.id matches the risk-tiers/severity-tiers/coordinator wiring', () => {
  assert.equal(meta.id, 'soft-404-nginx');
});

test('generate() returns a fixed, contentless draft — the real work happens at apply time', async () => {
  const draft = await generate({ siteId: 1, params: {} });
  assert.deepEqual(draft.content, {});
  assert.match(draft.summary, /real 404 status/);
});
