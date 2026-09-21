import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// syncFromGrounded's own module transitively imports ../runner.js, which
// loads the whole agent registry and, through llm.js -> openai, a
// transitive dependency (formdata-node/web-streams-polyfill) that fails to
// instantiate under node:test's module mocking — the same issue
// analyst-sync.test.js documents. Every collaborator is mocked narrowly so
// that chain is never actually reached.
let inserted, merged, refreshed, closedStaleArgs, markedUnfixable, openRecommendation;

mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    findOpenRecommendation: async () => openRecommendation,
    insertRecommendation: async (siteId, rec) => { inserted.push(rec); return { id: inserted.length }; },
    mergeIntoRecommendation: async (id, patch) => { merged.push({ id, ...patch }); },
    refreshRecommendationBlockState: async (id, patch) => { refreshed.push({ id, ...patch }); },
    listOpenBlockedRecommendations: async () => [],
    closeStaleRecommendations: async (siteId, keys, checked) => { closedStaleArgs = { siteId, keys, checked }; return 0; },
    markRecommendationsUnfixable: async (siteId, dropped) => { markedUnfixable = { siteId, dropped }; return dropped.length; },
    listOpenRecommendations: async () => [],
    getRecommendationById: async () => null,
    closeRecommendation: async () => {},
  },
});
mock.module(resolve('../../store/drafts.js'), { namedExports: {
  getDraftedFindingIds: async () => new Set(),
  // getRecommendations now derives each card's lifecycle from its live
  // draft rather than only asking whether one exists, so the mock has to
  // supply this too. Empty map = no drafts, which is what these tests mean.
  getLiveDraftsByFindingId: async () => new Map(),
} });
mock.module(resolve('../../store/recommendation-attempts.js'), { namedExports: {
  attemptSummaryByFinding: async () => new Map(),
} });
mock.module(resolve('./command-center.js'), { namedExports: { categoryByAgentId: async () => new Map() } });
mock.module(resolve('../runner.js'), { namedExports: { runAgent: async () => { throw new Error('must not be reached by syncFromGrounded'); } } });
mock.module(resolve('./recommendation-gates.js'), { namedExports: { createRecommendationGates: () => { throw new Error('must not be reached by syncFromGrounded'); } } });

const { syncFromGrounded } = await import('./recommendation-coordinator.js');

beforeEach(() => {
  inserted = []; merged = []; refreshed = []; closedStaleArgs = null; markedUnfixable = null; openRecommendation = null;
});

// The immortal-row bug this closes: a page buildRecommendations proved
// unfixable this run (soft-404, a mapped file confirmed gone) was previously
// just absent from detectedKeys, leaving it to closeStaleRecommendations'
// rotation-gated sweep — which never re-selects a page that no longer
// exists, so it never closed. droppedRecommendations is direct evidence
// gathered THIS run, and must be acted on immediately.
describe('syncFromGrounded — droppedRecommendations reach markRecommendationsUnfixable', () => {
  test('a dropped recommendation is marked unfixable, independent of closeStaleRecommendations', async () => {
    await syncFromGrounded(7, {
      items: [],
      detectedKeys: new Set(),
      droppedRecommendations: [{ generatorId: 'alt-text', page: 'https://x.com/docs/gone/', reason: 'soft-404' }],
    });

    assert.ok(markedUnfixable, 'markRecommendationsUnfixable must be called');
    assert.equal(markedUnfixable.siteId, 7);
    assert.deepEqual(markedUnfixable.dropped, [{ generatorId: 'alt-text', page: 'https://x.com/docs/gone/', reason: 'soft-404' }]);
    assert.ok(closedStaleArgs, 'the ordinary stale sweep still runs alongside it');
  });

  test('no dropped recommendations this run — markRecommendationsUnfixable is never called', async () => {
    await syncFromGrounded(7, { items: [], detectedKeys: new Set(), droppedRecommendations: [] });
    assert.equal(markedUnfixable, null, 'an empty list must not issue a pointless query');
  });

  test('grounded output with no droppedRecommendations key at all (older shape) does not throw', async () => {
    await syncFromGrounded(7, { items: [], detectedKeys: new Set() });
    assert.equal(markedUnfixable, null);
  });
});

// The tracking-ID staleness bug (2026-09-08): analytics-install's finding id
// (`trust-compliance:ga4:missing`) is deterministic and stays IDENTICAL every
// day the tracker remains uninstalled, so re-detecting the exact same finding
// used to early-return before ever calling mergeIntoRecommendation — the only
// place params get refreshed. A recommendation created before the site's real
// GA4 ID was configured in the database therefore never picked that ID up
// through ordinary daily sync; only the failure-triggered recovery path
// (action-center-reconciler.js, gated behind MAX_FAILED_ATTEMPTS) eventually
// forced a refresh. Confirmed live: recommendation #47 on site 1 carried no
// trackingId for 17 days and 15 failed drafts before that recovery path
// finally set it. syncFromGrounded must merge fresh params on EVERY sync,
// whether or not the finding id changed.
describe('syncFromGrounded — repeat-finding params refresh (tracking-ID staleness fix)', () => {
  test('a recommendation with an unchanged finding id still gets fresh params merged', async () => {
    openRecommendation = {
      id: 47,
      finding_ids: ['trust-compliance:ga4:missing'],
      detecting_agents: ['trust-compliance'],
      supporting_agents: [],
      blocked_reason: null,
      risk_tier: 'safe',
    };

    await syncFromGrounded(1, {
      items: [{
        id: 'trust-compliance:ga4:missing',
        generatorId: 'analytics-install',
        source: 'trust-compliance',
        reason: 'No Google Analytics detected',
        // The whole point: trackingId is now populated because the site's
        // real config was read fresh this sync, even though the finding id
        // itself is identical to yesterday's.
        params: { provider: 'ga4', page: 'https://zunkireelabs.com/', trackingId: 'G-2ZQRDS0D14' },
        priority: 'medium',
      }],
      detectedKeys: new Set(['trust-compliance:ga4:missing']),
    });

    assert.equal(merged.length, 1, 'mergeIntoRecommendation must be called even for an already-seen finding id');
    assert.equal(merged[0].id, 47);
    assert.deepEqual(merged[0].params, { provider: 'ga4', page: 'https://zunkireelabs.com/', trackingId: 'G-2ZQRDS0D14' });
    assert.equal(refreshed.length, 0, 'the old block-state-only refresh path is fully replaced by the merge, not run twice');
  });

  test('a genuinely new finding id on an existing recommendation still merges (unchanged behavior)', async () => {
    openRecommendation = {
      id: 9,
      finding_ids: ['expand-content:/blog/a/:thin'],
      detecting_agents: ['content-gap'],
      supporting_agents: [],
      blocked_reason: null,
      risk_tier: 'safe',
    };

    await syncFromGrounded(1, {
      items: [{
        id: 'expand-content:/blog/a/:thin-v2',
        generatorId: 'expand-content',
        source: 'content-gap',
        reason: 'still thin',
        params: { page: '/blog/a/' },
        priority: 'low',
      }],
      detectedKeys: new Set(['expand-content:/blog/a/:thin-v2']),
    });

    assert.equal(merged.length, 1);
    assert.equal(merged[0].findingId, 'expand-content:/blog/a/:thin-v2');
  });
});

// Regression coverage for a real report on site 1 (recommendations #42 and
// #5994): recommendation-gates.js's evaluate() deliberately never rules on
// broken-link-fix (computeBrokenLinkFixMerge has its own code-search
// fallback instead), so item.blockedReason is always null for it, no matter
// what happened at ship time. Before this fix, syncFromGrounded's "refresh
// the block both directions every sync" rule (correct for every OTHER
// generator, whose blockedReason IS a live gate re-check) treated that null
// as "verified clear" and silently wiped out the real needs_human block
// action-center.js had set after a genuine failed ship attempt — the
// recommendation flapped blocked -> unblocked -> retried -> failed
// identically -> blocked again, forever, and never converged.
describe('syncFromGrounded — broken-link-fix preserves a ship-time block (gates has no opinion on it)', () => {
  test('an existing needs_human block survives a re-detection with no gate signal', async () => {
    openRecommendation = {
      id: 5994,
      finding_ids: ['technical-seo:invalid-citation:https://zunkireelabs.com/contact/?source=newsletter:https://twitter.com/zunkiree'],
      detecting_agents: ['technical-seo'],
      supporting_agents: [],
      blocked_reason: 'The file containing this link could not be located in the site’s repository.',
      risk_tier: 'manual',
    };

    await syncFromGrounded(1, {
      items: [{
        id: 'technical-seo:invalid-citation:https://zunkireelabs.com/contact/?source=newsletter:https://twitter.com/zunkiree',
        generatorId: 'broken-link-fix',
        source: 'technical-seo',
        reason: 'A cited external source (https://twitter.com/zunkiree, on 1 page(s)) now returns HTTP 404 — the citation is dead.',
        // technical-seo.js never sets blockedReason for this finding type —
        // this is the realistic shape of every nightly re-detection.
        params: { href: 'https://twitter.com/zunkiree', page: 'https://zunkireelabs.com/contact/?source=newsletter' },
        priority: 'medium',
      }],
      detectedKeys: new Set(['technical-seo:invalid-citation:https://zunkireelabs.com/contact/?source=newsletter:https://twitter.com/zunkiree']),
    });

    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 5994);
    assert.equal(merged[0].blockedReason, 'The file containing this link could not be located in the site’s repository.');
    assert.equal(merged[0].riskTier, 'manual');
  });

  test('a broken-link-fix recommendation with no prior block still opens unblocked (unchanged behavior)', async () => {
    openRecommendation = {
      id: 6001,
      finding_ids: ['technical-seo:invalid-citation:https://zunkireelabs.com/:https://example.com'],
      detecting_agents: ['technical-seo'],
      supporting_agents: [],
      blocked_reason: null,
      risk_tier: 'safe',
    };

    await syncFromGrounded(1, {
      items: [{
        id: 'technical-seo:invalid-citation:https://zunkireelabs.com/:https://example.com',
        generatorId: 'broken-link-fix',
        source: 'technical-seo',
        reason: 'A cited external source (https://example.com, on 1 page(s)) now returns HTTP 404 — the citation is dead.',
        params: { href: 'https://example.com', page: 'https://zunkireelabs.com/' },
        priority: 'medium',
      }],
      detectedKeys: new Set(['technical-seo:invalid-citation:https://zunkireelabs.com/:https://example.com']),
    });

    assert.equal(merged.length, 1);
    assert.equal(merged[0].blockedReason, null);
    assert.equal(merged[0].riskTier, 'safe');
  });
});
