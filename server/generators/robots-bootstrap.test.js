import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './robots-bootstrap.js';

describe('robots-bootstrap generator', () => {
  test('drafts a permissive baseline with no patterns', async () => {
    const { content } = await generate({ params: {} });
    assert.match(content.robotsTxt, /^User-agent: \*\nAllow: \/\n$/);
    assert.deepEqual(content.disallowPatterns, []);
  });

  test('drafts Disallow rules inside the ROBOTS-FIX marker for real patterns', async () => {
    const { content } = await generate({ params: { disallowPatterns: ['/shop/*', '/*?h=*'] } });
    assert.match(content.robotsTxt, /Allow: \//);
    assert.match(content.robotsTxt, /# SEOAI:ROBOTS-FIX:START/);
    assert.match(content.robotsTxt, /Disallow: \/shop\/\*/);
    assert.match(content.robotsTxt, /Disallow: \/\*\?h=\*/);
    assert.match(content.robotsTxt, /# SEOAI:ROBOTS-FIX:END/);
  });

  test('drops falsy pattern entries rather than emitting a blank Disallow', async () => {
    const { content } = await generate({ params: { disallowPatterns: ['/shop/*', '', null] } });
    assert.equal(content.disallowPatterns.length, 1);
    assert.doesNotMatch(content.robotsTxt, /Disallow: $/m);
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'robots-bootstrap');
  });
});
