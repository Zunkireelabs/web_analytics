import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './qa-content.js';

// Only exercises the input-validation path, which throws before ever
// fetching the live page or calling the LLM — no real network needed.
describe('qa-content generator', () => {
  test('requires page', async () => {
    await assert.rejects(() => generate({ params: {} }));
  });

  test('meta.id matches the generatorId geo-signals.js wires into recommendedAction', () => {
    assert.equal(meta.id, 'qa-content');
  });
});
