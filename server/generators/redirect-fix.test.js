import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './redirect-fix.js';

describe('redirect-fix generator', () => {
  test('passes through page/oldHref/newHref verbatim', async () => {
    const { content } = await generate({ params: { page: 'https://example.com/a', oldHref: '/old', newHref: 'https://example.com/new' } });
    assert.equal(content.oldHref, '/old');
    assert.equal(content.newHref, 'https://example.com/new');
  });

  test('requires page', async () => {
    await assert.rejects(() => generate({ params: { oldHref: '/old', newHref: 'https://example.com/new' } }));
  });

  test('requires both oldHref and newHref', async () => {
    await assert.rejects(() => generate({ params: { page: 'https://example.com/a', oldHref: '/old' } }));
  });

  test('rejects a malformed newHref', async () => {
    await assert.rejects(() => generate({ params: { page: 'https://example.com/a', oldHref: '/old', newHref: 'not a url' } }));
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'redirect-fix');
  });
});
