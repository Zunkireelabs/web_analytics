import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let analyzeResultByUrl; // url -> {ok, analysis?, error?}

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSiteById: async () => site,
    // Not exercised by this generator's own code — a stub is needed only
    // because site-domain.js (ownDomains' module) imports it from the same
    // file, and mock.module replaces the whole module's named exports.
    getSearchPerformanceRange: async () => [],
  },
});
mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: {
    analyzePageUrl: async (url) => analyzeResultByUrl.get(url) || { ok: true, analysis: { hasCanonical: false } },
  },
});

const { generate, meta } = await import('./canonical.js');

// Only exercises the input-validation path, which throws before ever
// calling getSiteById — no real DB needed. The domain-confirmation /
// success path is covered by manual/sandbox verification (see the plan's
// end-to-end verification steps), since it requires a real site row.
describe('canonical generator', () => {
  test('requires page', async () => {
    await assert.rejects(() => generate({ siteId: 1, params: {} }));
  });

  test('rejects a malformed page URL before touching the database', async () => {
    await assert.rejects(() => generate({ siteId: 1, params: { page: 'not a url' } }));
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'canonical');
  });
});

describe('canonical generator — cross-page canonicalTarget (evidence-based consolidation)', () => {
  const page = 'https://example.com/about';
  const target = 'https://example.com/about/';

  test('with no canonicalTarget, drafts a self-referential canonical (unchanged existing behavior)', async () => {
    site = { id: 1, website_domain: 'example.com' };
    analyzeResultByUrl = new Map();
    const draft = await generate({ siteId: 1, params: { page } });
    assert.equal(draft.content.canonicalUrl, page);
  });

  test('with a valid canonicalTarget, drafts a canonical pointing at the target instead of self', async () => {
    site = { id: 1, website_domain: 'example.com' };
    analyzeResultByUrl = new Map([[target, { ok: true, analysis: { hasCanonical: false } }]]);
    const draft = await generate({ siteId: 1, params: { page, canonicalTarget: target } });
    assert.equal(draft.content.canonicalUrl, target);
    assert.match(draft.summary, /consolidating a duplicate URL variant/);
  });

  test('refuses when canonicalTarget is off-domain', async () => {
    site = { id: 1, website_domain: 'example.com' };
    analyzeResultByUrl = new Map();
    await assert.rejects(() => generate({ siteId: 1, params: { page, canonicalTarget: 'https://not-this-site.com/x' } }));
  });

  test('refuses when canonicalTarget equals page — nothing to consolidate', async () => {
    site = { id: 1, website_domain: 'example.com' };
    analyzeResultByUrl = new Map();
    await assert.rejects(() => generate({ siteId: 1, params: { page, canonicalTarget: page } }));
  });

  test('refuses (stale) when canonicalTarget can no longer be confirmed live', async () => {
    site = { id: 1, website_domain: 'example.com' };
    analyzeResultByUrl = new Map([[target, { ok: false, error: 'Not Found' }]]);
    await assert.rejects(
      () => generate({ siteId: 1, params: { page, canonicalTarget: target } }),
      (err) => err.stale === true && err.refusal === true,
    );
  });

  test('refuses (stale) when page already has a DIFFERENT canonical — a prior decision stands', async () => {
    site = { id: 1, website_domain: 'example.com' };
    analyzeResultByUrl = new Map([
      [target, { ok: true, analysis: { hasCanonical: false } }],
      [page, { ok: true, analysis: { hasCanonical: true } }],
    ]);
    await assert.rejects(
      () => generate({ siteId: 1, params: { page, canonicalTarget: target } }),
      (err) => err.stale === true,
    );
  });
});
