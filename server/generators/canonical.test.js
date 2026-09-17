import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let analyzeResultByUrl; // url -> {ok, analysis?, error?}

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSiteById: async () => site,
    // Not exercised by this generator's own code — stubs are needed only
    // because site-domain.js (ownDomains' module) and duplicate-evidence.js
    // (verifyCurrentState's textSimilarity, which is otherwise pure and
    // needs neither) import from the same file, and mock.module replaces
    // the whole module's named exports.
    getSearchPerformanceRange: async () => [],
    getSearchPerformanceForPages: async () => [],
    getQueryPageMetrics: async () => [],
  },
});
mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: {
    analyzePageUrl: async (url) => analyzeResultByUrl.get(url) || { ok: true, analysis: { hasCanonical: false } },
  },
});

const { generate, meta, verifyCurrentState } = await import('./canonical.js');

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

describe('canonical verifyCurrentState (server/generators/lib/verification-layer.js contract)', () => {
  const page = 'https://example.com/about';
  const target = 'https://example.com/about-us';

  test('missing page: still_valid without calling anything', async () => {
    analyzeResultByUrl = new Map();
    const result = await verifyCurrentState({ params: {} }, {});
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'missing-params');
  });

  test('page already canonicalizes to exactly the intended target: already_resolved', async () => {
    analyzeResultByUrl = new Map([
      [page, { ok: true, analysis: { hasCanonical: true, canonicalUrl: target } }],
    ]);
    const result = await verifyCurrentState({ params: { page, canonicalTarget: target } }, {});
    assert.equal(result.decision, 'already_resolved');
  });

  test('self-referential case: canonical already points at the page itself: already_resolved', async () => {
    analyzeResultByUrl = new Map([
      [page, { ok: true, analysis: { hasCanonical: true, canonicalUrl: page } }],
    ]);
    const result = await verifyCurrentState({ params: { page } }, {});
    assert.equal(result.decision, 'already_resolved');
  });

  test('a DIFFERENT canonical already lives on the page: conflict, not a blind refusal', async () => {
    analyzeResultByUrl = new Map([
      [page, { ok: true, analysis: { hasCanonical: true, canonicalUrl: 'https://example.com/somewhere-else' } }],
    ]);
    const result = await verifyCurrentState({ params: { page, canonicalTarget: target } }, {});
    assert.equal(result.decision, 'conflict');
    assert.equal(result.reason, 'different-canonical-already-present');
  });

  test('no canonical, no cross-page target: still_valid, plain missing-tag fix', async () => {
    analyzeResultByUrl = new Map([
      [page, { ok: true, analysis: { hasCanonical: false } }],
    ]);
    const result = await verifyCurrentState({ params: { page } }, {});
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'no-canonical-present');
  });

  test('cross-page target no longer reachable: still_valid, not a guess either way', async () => {
    analyzeResultByUrl = new Map([
      [page, { ok: true, analysis: { hasCanonical: false } }],
      [target, { ok: false, error: 'timeout' }],
    ]);
    const result = await verifyCurrentState({ params: { page, canonicalTarget: target } }, {});
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'target-unreachable');
  });

  test('single detecting agent, target still live and unfetched-similarity is never even checked: still_valid, fixable-now', async () => {
    analyzeResultByUrl = new Map([
      [page, { ok: true, analysis: { hasCanonical: false, bodyText: 'anything at all' } }],
      [target, { ok: true, analysis: { hasCanonical: false, bodyText: 'completely unrelated text no overlap' } }],
    ]);
    const result = await verifyCurrentState({ params: { page, canonicalTarget: target }, detecting_agents: ['duplicate-content'] }, {});
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'fixable-now');
  });

  test('multiple detecting agents AND content still substantially similar: still_valid — corroboration, not suspicion', async () => {
    const sharedText = 'the quick brown fox jumps over the lazy dog every single day near the river';
    analyzeResultByUrl = new Map([
      [page, { ok: true, analysis: { hasCanonical: false, bodyText: sharedText } }],
      [target, { ok: true, analysis: { hasCanonical: false, bodyText: sharedText } }],
    ]);
    const result = await verifyCurrentState(
      { params: { page, canonicalTarget: target }, detecting_agents: ['duplicate-content', 'url-variant-duplicates'] }, {},
    );
    assert.equal(result.decision, 'still_valid');
  });

  test('multiple detecting agents AND stored target no longer matches content: conflict — cannot safely re-pick a winner', async () => {
    analyzeResultByUrl = new Map([
      [page, { ok: true, analysis: { hasCanonical: false, bodyText: 'alpha bravo charlie delta echo foxtrot' } }],
      [target, { ok: true, analysis: { hasCanonical: false, bodyText: 'golf hotel india juliet kilo lima' } }],
    ]);
    const result = await verifyCurrentState(
      { params: { page, canonicalTarget: target }, detecting_agents: ['duplicate-content', 'url-variant-duplicates'] }, {},
    );
    assert.equal(result.decision, 'conflict');
    assert.equal(result.reason, 'stored-target-no-longer-matches-content');
    assert.equal(result.evidence.similarity, 0);
  });
});
