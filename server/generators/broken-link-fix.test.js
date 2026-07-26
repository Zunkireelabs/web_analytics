import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './broken-link-fix.js';

describe('broken-link-fix generator', () => {
  test('passes through page/href verbatim, never fabricates a replacement', async () => {
    const { content } = await generate({ params: { page: 'https://example.com/a', href: '/dead' } });
    assert.equal(content.page, 'https://example.com/a');
    assert.equal(content.href, '/dead');
    assert.deepEqual(content.sourcePages, ['https://example.com/a']); // defaults to [page]
    assert.equal(Object.keys(content).length, 3); // no invented target field
  });

  test('forwards sourcePages when the crawler found the href on multiple pages', async () => {
    const { content } = await generate({
      params: { page: 'https://example.com/a', href: '/dead', sourcePages: ['https://example.com/a', 'https://example.com/b'] },
    });
    assert.deepEqual(content.sourcePages, ['https://example.com/a', 'https://example.com/b']);
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
