import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './canonical.js';

// Only exercises the input-validation path, which throws before ever
// calling getSiteById — no real DB needed. The domain-confirmation /
// success path is covered by manual/sandbox verification (see the plan's
// end-to-end verification steps), since it requires a real site row.
describe('canonical generator', () => {
  test('requires page', async () => {
    await assert.rejects(() => generate({ siteId: 1, params: {} }));
  });

  test('rejects a malformed page URL before touching the database', async () => {
    await assert.rejects(() => generate({ siteId: 1, params: { page: 'not a url' } }));
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'canonical');
  });
});
