import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let existingRec;
let inserted;
let synced;
let drafted;
let draftShouldFail;

const realRecommendations = await import(resolve('../../store/recommendations.js'));
mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    ...realRecommendations,
    findOpenRecommendation: async () => existingRec,
    insertRecommendation: async (siteId, payload) => { inserted.push(payload); return { id: 999 }; },
  },
});
// syncFromGrounded is recommendation-coordinator.js's own routing entrypoint
// (dedup, block-state refresh, stale-closure) — its OWN behavior has its own
// test file (recommendation-coordinator.test.js). What matters HERE is only
// that a routable finding reaches it, shaped correctly, same "mock the
// collaborator wholesale" convention action-center-reconciler.test.js uses
// for batch-pr-recovery.js.
mock.module(resolve('./recommendation-coordinator.js'), {
  namedExports: {
    syncFromGrounded: async (siteId, grounded) => { synced.push({ siteId, ...grounded }); },
  },
});
// Same wholesale-mock convention for the Design Agent's own producer call
// (generateDraft, source: 'design-agent') — its own behavior (idempotency,
// generation) is action-center.js's own test file's concern.
mock.module(resolve('../../routes/action-center.js'), {
  namedExports: {
    generateDraft: async (siteId, opts) => {
      drafted.push({ siteId, ...opts });
      if (draftShouldFail) throw new Error('quality gate exhausted');
      return { id: 111 };
    },
  },
});

const { persistConsistencyFindings } = await import(resolve('./design-consistency.js'));

beforeEach(() => { existingRec = null; inserted = []; synced = []; drafted = []; draftShouldFail = false; });

// No outerHtml/siteConvention by default — NOT routable, so every existing
// test below (written before routing existed) keeps landing in the manual
// bundle unchanged. Tests that need a routable finding build one explicitly
// via routableFinding() below.
const finding = (overrides = {}) => ({
  id: 'typography-drift', pageUrl: 'https://example.com/legal/privacy',
  pageType: 'legal', sectionRole: 'content', sectionOrder: 0,
  evidence: { sectionClasses: 'x', siteConvention: 'y' },
  ...overrides,
});

const routableFinding = (overrides = {}) => finding({
  evidence: { sectionClasses: 'old classes', siteConvention: 'new classes', outerHtml: '<p class="old classes">Hi</p>', textRole: 'body' },
  ...overrides,
});

describe('persistConsistencyFindings', () => {
  test('an empty finding list persists nothing', async () => {
    const result = await persistConsistencyFindings(1, []);
    assert.equal(result.manualCreated, 0);
    assert.equal(result.automatable, 0);
    assert.equal(inserted.length, 0);
    assert.equal(synced.length, 0);
  });

  test('several NON-routable findings on the SAME page collapse into ONE manual recommendation', async () => {
    const result = await persistConsistencyFindings(1, [
      finding({ id: 'typography-drift' }),
      finding({ id: 'missing-responsive-classes', sectionOrder: 1 }),
      finding({ id: 'table-style-drift', sectionOrder: 2 }),
    ]);
    assert.equal(result.manualCreated, 1);
    assert.equal(result.automatable, 0);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].page, 'https://example.com/legal/privacy');
    assert.match(inserted[0].issue, /3 section\(s\)/);
  });

  test('findings on different pages become separate manual recommendations', async () => {
    const result = await persistConsistencyFindings(1, [
      finding({ pageUrl: 'https://example.com/a' }),
      finding({ pageUrl: 'https://example.com/b' }),
    ]);
    assert.equal(result.manualCreated, 2);
    assert.equal(inserted.length, 2);
  });

  test('a page that already has an open review recommendation is skipped, not duplicated', async () => {
    existingRec = { id: 5 };
    const result = await persistConsistencyFindings(1, [finding()]);
    assert.equal(result.manualCreated, 0);
    assert.equal(result.manualSkipped, 1);
    assert.equal(inserted.length, 0);
  });

  test('a manual-bundle recommendation is always risk-tier manual', async () => {
    await persistConsistencyFindings(1, [finding()]);
    assert.equal(inserted[0].riskTier, 'manual');
    assert.equal(inserted[0].recommendationType, 'design-consistency-review');
  });

  test('3+ manual findings on one page escalate priority to high', async () => {
    await persistConsistencyFindings(1, [finding(), finding({ sectionOrder: 1 }), finding({ sectionOrder: 2 })]);
    assert.equal(inserted[0].priority, 'high');
  });

  test('1-2 manual findings on one page stay medium priority', async () => {
    await persistConsistencyFindings(1, [finding()]);
    assert.equal(inserted[0].priority, 'medium');
  });

  test('missing-responsive-classes is never routed, even with fabricated outerHtml — no known-correct target class string exists for it', async () => {
    const result = await persistConsistencyFindings(1, [
      finding({ id: 'missing-responsive-classes', evidence: { sectionClasses: 'x', siteBreakpoints: ['sm:', 'md:'], outerHtml: '<div class="x"></div>' } }),
    ]);
    assert.equal(result.automatable, 0);
    assert.equal(result.manualCreated, 1);
    assert.equal(synced.length, 0);
  });

  test('a table-style-drift finding with a real anchor and target is routed, not made manual', async () => {
    const result = await persistConsistencyFindings(1, [
      routableFinding({ id: 'table-style-drift', evidence: { sectionClasses: 'old-table', siteConvention: 'new-table', outerHtml: '<table class="old-table"></table>' } }),
    ]);
    assert.equal(result.automatable, 1);
    assert.equal(result.manualCreated, 0);
    assert.equal(inserted.length, 0, 'a fully-routable page must not also get a manual review row');
    assert.equal(synced.length, 1);
    const item = synced[0].items[0];
    assert.equal(item.generatorId, 'content-integrity-repair');
    assert.equal(item.params.fixType, 'table-style-drift');
    assert.equal(item.params.page, 'https://example.com/legal/privacy');
    assert.equal(item.params.outerHtml, '<table class="old-table"></table>');
    assert.equal(item.params.siteConvention, 'new-table');

    // Design Agent's own genuine producer entry — a real draft, distinctly
    // labeled, not folded into generic 'auto-remediation' accounting.
    assert.equal(drafted.length, 1);
    assert.equal(drafted[0].source, 'design-agent');
    assert.equal(drafted[0].generatorId, 'content-integrity-repair');
    assert.equal(drafted[0].findingId, item.id);
  });

  test('a generateDraft failure for the producer call does not break persistence — fails open to the next daily pass', async () => {
    draftShouldFail = true;
    const result = await persistConsistencyFindings(1, [
      routableFinding({ id: 'table-style-drift', evidence: { sectionClasses: 'old-table', siteConvention: 'new-table', outerHtml: '<table class="old-table"></table>' } }),
    ]);
    assert.equal(result.automatable, 1);
    assert.equal(synced.length, 1, 'the recommendation still gets synced even if the eager draft fails');
    assert.equal(drafted.length, 1, 'the attempt was made');
  });

  test('a typography-drift finding missing outerHtml (capture failed) falls back to manual, not a broken route', async () => {
    const result = await persistConsistencyFindings(1, [
      finding({ id: 'typography-drift', evidence: { sectionClasses: 'x', siteConvention: 'y' } }),
    ]);
    assert.equal(result.automatable, 0);
    assert.equal(result.manualCreated, 1);
    assert.equal(synced.length, 0);
  });

  test('a page with BOTH a routable and a genuinely manual finding gets both: one routed item and one manual row for just the leftover', async () => {
    const result = await persistConsistencyFindings(1, [
      routableFinding({ id: 'typography-drift', sectionOrder: 0 }),
      finding({ id: 'missing-responsive-classes', sectionOrder: 1, evidence: { sectionClasses: 'z', siteBreakpoints: ['sm:'] } }),
    ]);
    assert.equal(result.automatable, 1);
    assert.equal(result.manualCreated, 1);
    assert.equal(inserted.length, 1);
    assert.match(inserted[0].issue, /1 section\(s\)/, 'the manual row must only count the leftover finding, not the routed one too');
    assert.equal(synced.length, 1);
    assert.equal(synced[0].items.length, 1);
  });

  test('two routable findings on the same page produce two distinct routed items (not collapsed)', async () => {
    await persistConsistencyFindings(1, [
      routableFinding({ id: 'typography-drift', sectionOrder: 0, evidence: { sectionClasses: 'a', siteConvention: 'b', outerHtml: '<p class="a">x</p>', textRole: 'body' } }),
      routableFinding({ id: 'typography-drift', sectionOrder: 1, evidence: { sectionClasses: 'c', siteConvention: 'd', outerHtml: '<h2 class="c">y</h2>', textRole: 'heading' } }),
    ]);
    assert.equal(synced[0].items.length, 2);
    assert.notEqual(synced[0].items[0].id, synced[0].items[1].id);
    assert.equal(drafted.length, 2);
    assert.ok(drafted.every((d) => d.source === 'design-agent'));
  });
});
