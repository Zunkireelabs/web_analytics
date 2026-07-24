import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './robots-fix.js';

describe('robots-fix generator', () => {
  test('drafts a surgical Allow override referencing the blocking pattern', async () => {
    const { content } = await generate({ params: { pagePath: '/blog/post', blockedPattern: '/blog' } });
    assert.match(content.robotsBlock, /Allow: \/blog\/post/);
    assert.match(content.robotsBlock, /Disallow: \/blog/);
    assert.doesNotMatch(content.robotsBlock, /^Disallow:/m); // never emits a Disallow itself, only Allow
  });

  test('still drafts an Allow when blockedPattern is unknown', async () => {
    const { content } = await generate({ params: { pagePath: '/blog/post', blockedPattern: null } });
    assert.match(content.robotsBlock, /Allow: \/blog\/post/);
  });

  test('requires pagePath', async () => {
    await assert.rejects(() => generate({ params: {} }));
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'robots-fix');
  });
});
