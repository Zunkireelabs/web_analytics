import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let analyzeImpl;
mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: { analyzePageUrl: async (url) => analyzeImpl(url) },
});

const { generate, meta, verifyCurrentState } = await import('./html-lang.js');

// Only exercises the params.lang-provided path, which never calls
// getSiteById — no real DB needed. The site-config-lookup / 'en' fallback
// path is covered by injectHtmlLang's own tests plus manual/sandbox
// verification (see the plan's end-to-end verification steps), since it
// requires a real site row.
describe('html-lang generator', () => {
  test('uses an explicit params.lang override when given', async () => {
    const { content } = await generate({ siteId: 1, params: { lang: 'fr' } });
    assert.equal(content.lang, 'fr');
  });

  test('accepts a region-qualified code', async () => {
    const { content } = await generate({ siteId: 1, params: { lang: 'en-US' } });
    assert.equal(content.lang, 'en-US');
  });

  test('falls back to "en" for a malformed lang value rather than drafting garbage', async () => {
    const { content } = await generate({ siteId: 1, params: { lang: 'not-a-lang-code!' } });
    assert.equal(content.lang, 'en');
  });

  test('falls back to "en" for an empty string', async () => {
    const { content } = await generate({ siteId: 1, params: { lang: '' } });
    assert.equal(content.lang, 'en');
  });

  test('summary names the resolved language', async () => {
    const { summary } = await generate({ siteId: 1, params: { lang: 'fr' } });
    assert.match(summary, /lang="fr"/);
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'html-lang');
  });
});

describe('html-lang verifyCurrentState (server/generators/lib/verification-layer.js contract)', () => {
  const site = { id: 1, website_domain: 'example.com' };

  test('no site context: still_valid without guessing', async () => {
    const result = await verifyCurrentState({ params: {} }, {});
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'no-site-context');
  });

  test('no checkable target (no page and no site domain): still_valid', async () => {
    const result = await verifyCurrentState({ params: {} }, { site: {} });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'no-checkable-target');
  });

  test('live page already has <html lang>: already_resolved', async () => {
    analyzeImpl = async () => ({ ok: true, analysis: { htmlLang: 'en' } });
    const result = await verifyCurrentState({ params: {} }, { site });
    assert.equal(result.decision, 'already_resolved');
    assert.equal(result.reason, 'html-lang-present');
  });

  test('live page still has no <html lang>: still_valid', async () => {
    analyzeImpl = async () => ({ ok: true, analysis: { htmlLang: null } });
    const result = await verifyCurrentState({ params: {} }, { site });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'html-lang-missing');
  });

  test('unreachable: still_valid, not a guess either way', async () => {
    analyzeImpl = async () => ({ ok: false, error: 'timeout' });
    const result = await verifyCurrentState({ params: {} }, { site });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'unreachable');
  });
});
