import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './expand-content.js';

// Only exercises the input-validation path, which throws before ever
// fetching the live page or calling the LLM — no real network needed.
describe('expand-content generator', () => {
  test('requires page', async () => {
    await assert.rejects(() => generate({ params: {} }));
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'expand-content');
  });
});
