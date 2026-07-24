import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './broken-link-fix.js';

describe('broken-link-fix generator', () => {
  test('passes through page/href verbatim, never fabricates a replacement', async () => {
    const { content } = await generate({ params: { page: 'https://example.com/a', href: '/dead' } });
    assert.equal(content.page, 'https://example.com/a');
    assert.equal(content.href, '/dead');
    assert.equal(Object.keys(content).length, 2); // no invented target field
  });

  test('requires page', async () => {
    await assert.rejects(() => generate({ params: { href: '/dead' } }));
  });

  test('requires href', async () => {
    await assert.rejects(() => generate({ params: { page: 'https://example.com/a' } }));
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'broken-link-fix');
  });
});
