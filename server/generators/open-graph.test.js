import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './open-graph.js';

// Only exercises the input-validation path, which throws before ever
// fetching the live page — no real network needed. The real-content-
// grounding path is covered by manual/sandbox verification.
describe('open-graph generator', () => {
  test('requires page', async () => {
    await assert.rejects(() => generate({ params: {} }));
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'open-graph');
  });
});
