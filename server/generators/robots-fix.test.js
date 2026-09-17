import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let fetchTextImpl;
// Spread the real module's other exports — site-discovery.js (which
// robots-fix.js's verifyCurrentState also imports, for the real, unmocked
// parseRobotsDisallowRules) statically imports analyzePageUrl/
// isPrivateOrLocalHost from this same module, so a namedExports object with
// only fetchTextIfExists would leave those undefined.
const realPageContent = await import(resolve('../agents/lib/page-content.js'));
mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: { ...realPageContent, fetchTextIfExists: async (url) => fetchTextImpl(url) },
});

const { generate, meta, verifyCurrentState } = await import('./robots-fix.js');

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

describe('robots-fix verifyCurrentState (server/generators/lib/verification-layer.js contract)', () => {
  const site = { id: 1, website_domain: 'example.com' };
  const rec = { params: { pagePath: '/blog/post', blockedPattern: '/blog' } };

  test('no site context: still_valid without guessing', async () => {
    const result = await verifyCurrentState(rec, {});
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'no-site-context');
  });

  test('no robots.txt at all: already_resolved — nothing left to disallow it', async () => {
    fetchTextImpl = async () => ({ ok: false, error: 'not found' });
    const result = await verifyCurrentState(rec, { site });
    assert.equal(result.decision, 'already_resolved');
    assert.equal(result.reason, 'no-robots-txt');
  });

  test('the winning rule already allows the page (e.g. edited since detection): already_resolved', async () => {
    fetchTextImpl = async () => ({ ok: true, text: 'User-agent: *\nDisallow: /blog\nAllow: /blog/post\n' });
    const result = await verifyCurrentState(rec, { site });
    assert.equal(result.decision, 'already_resolved');
    assert.equal(result.reason, 'already-allowed');
  });

  test('still disallowed by the same real rule: still_valid', async () => {
    fetchTextImpl = async () => ({ ok: true, text: 'User-agent: *\nDisallow: /blog\n' });
    const result = await verifyCurrentState(rec, { site });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.evidence.matchingDisallow, '/blog');
  });

  test('missing pagePath: still_valid without calling anything', async () => {
    fetchTextImpl = async () => { throw new Error('must not be called'); };
    const result = await verifyCurrentState({ params: {} }, { site });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'missing-params');
  });
});
