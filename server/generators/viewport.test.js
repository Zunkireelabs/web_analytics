import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './viewport.js';

describe('viewport generator', () => {
  test('always emits the same correct value — no params needed', async () => {
    const { content } = await generate({ params: {} });
    assert.equal(content.viewportContent, 'width=device-width, initial-scale=1');
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'viewport');
  });
});
