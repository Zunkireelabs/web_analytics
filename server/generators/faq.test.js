import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './faq.js';

// Only exercises the input-validation path, which throws before ever
// calling the LLM — no real network/API key needed, same convention as the
// other generator tests. The page-purpose-guidance prompt content is
// covered by manual/sandbox verification, not unit tests; the rendered
// FAQ-block output is covered separately in marker-merge.test.js.
describe('faq generator', () => {
  test('requires query or topic', async () => {
    await assert.rejects(() => generate({ params: {} }));
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'faq');
  });
});
