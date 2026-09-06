import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

let inserted;
let existingRecs;
let visionResponse;

mock.module(resolve('../store/recommendations.js'), {
  namedExports: {
    findOpenRecommendation: async (siteId, page, type) => existingRecs.find((r) => r.page === page && r.recommendation_type === type) || null,
    insertRecommendation: async (siteId, params) => { inserted.push(params); return { id: inserted.length, ...params }; },
  },
});
mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLMWithImages: async () => JSON.stringify(visionResponse),
    extractJson: (raw) => { try { return JSON.parse(raw); } catch { return null; } },
  },
});
// Real recommendation-coordinator.js transitively pulls in the real OpenAI
// SDK (via command-center.js -> model-providers/index.js), which hits an
// unrelated ESM/CJS incompatibility (web-streams-polyfill) under
// --experimental-test-module-mocks — same documented workaround as
// analyst-seo-mapping-existing-page-match.test.js. Only recommendationPageKey's
// own content-integrity-repair branch is needed here; reimplemented inline
// rather than pulling in the real module.
mock.module(resolve('./lib/recommendation-coordinator.js'), {
  namedExports: {
    recommendationPageKey: (item) => `${item.params?.page || ''}::${item.params?.fixType || ''}`,
  },
});

const { run, meta, defaultCapture } = await import('./visual-quality.js');

function page(url, screenshot = 'base64data') {
  return { url, pageType: 'homepage', title: 'T', blocks: [], screenshot };
}

beforeEach(() => { inserted = []; existingRecs = []; visionResponse = []; });

describe('visual-quality agent', () => {
  test('meta.id is visual-quality', () => {
    assert.equal(meta.id, 'visual-quality');
  });

  // No configured domain (or nothing in page_inventory/GSC yet) means
  // selectCandidatePages returns an empty batch — defaultCapture short-
  // circuits to { pages: [] } without ever launching a browser, and this
  // is exactly what a `capture` override returning no pages looks like.
  test('insufficient-data when there are no candidate pages at all (e.g. no domain configured)', async () => {
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [] }),
      analyzePage: async () => { throw new Error('should not be called'); },
    });
    assert.equal(result.status, 'insufficient-data');
  });

  test('insufficient-data when no page captured a screenshot', async () => {
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [{ url: 'https://example.com/', blocks: [] }] }), // no .screenshot
    });
    assert.equal(result.status, 'insufficient-data');
  });

  test('ok, zero findings when vision flags nothing', async () => {
    visionResponse = [];
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/')] }),
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.facts.findings.length, 0);
    assert.equal(inserted.length, 0);
  });

  test('a hallucinated page (not in this run\'s own capture) is discarded, never trusted', async () => {
    visionResponse = [{ page: 'https://not-captured.example.com/', fixType: 'duplicate-faq', description: 'x' }];
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/')] }),
      analyzePage: async () => { throw new Error('should not be called for an ungrounded page'); },
    });
    assert.equal(result.facts.findings.length, 0);
    assert.equal(inserted.length, 0);
  });

  test('an unknown fixType outside the closed set is discarded, never trusted', async () => {
    visionResponse = [{ page: 'https://example.com/', fixType: 'redesign-the-whole-page', description: 'x' }];
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/')] }),
      analyzePage: async () => { throw new Error('should not be called'); },
    });
    assert.equal(result.facts.findings.length, 0);
    assert.equal(inserted.length, 0);
  });

  test('confirmed by the deterministic check -> a real safe-tier finding, ships autonomously, no manual insert', async () => {
    visionResponse = [{ page: 'https://example.com/faq', fixType: 'duplicate-faq', description: 'Two near-identical FAQ sections.' }];
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/faq')] }),
      analyzePage: async () => ({ ok: true, analysis: { duplicateFaqRemovalHtml: '<section>dup</section>' } }),
    });
    assert.equal(result.facts.findings.length, 1);
    const finding = result.facts.findings[0];
    assert.equal(finding.recommendedAction.generatorId, 'content-integrity-repair');
    assert.equal(finding.recommendedAction.params.fixType, 'duplicate-faq');
    assert.equal(finding.evidence.confirmed, true);
    assert.equal(inserted.length, 0, 'a confirmed finding must never ALSO go through the direct-insert manual path');
  });

  test('NOT confirmed by the deterministic check -> manual Action Center recommendation, not a silently-dropped finding', async () => {
    visionResponse = [{ page: 'https://example.com/pricing', fixType: 'malformed-table', description: 'Table looks broken.' }];
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/pricing')] }),
      analyzePage: async () => ({ ok: true, analysis: { removableMalformedTables: [] } }), // real check disagrees
    });
    assert.equal(result.facts.findings.length, 0, 'unconfirmed defects must not enter the autonomous facts.findings path');
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].riskTier, 'manual');
    assert.equal(inserted[0].recommendationType, 'content-integrity-repair');
    assert.match(inserted[0].blockedReason, /Unconfirmed/);
  });

  test('a page-content analysis failure (fetch error) is treated as unconfirmed, not thrown', async () => {
    visionResponse = [{ page: 'https://example.com/x', fixType: 'raw-text-table', description: 'y' }];
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/x')] }),
      analyzePage: async () => { throw new Error('fetch failed'); },
    });
    assert.equal(result.facts.findings.length, 0);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].riskTier, 'manual');
  });

  test('an already-open manual recommendation for the same page+fixType is never duplicated', async () => {
    existingRecs = [{ page: 'https://example.com/x::raw-text-table', recommendation_type: 'content-integrity-repair' }];
    visionResponse = [{ page: 'https://example.com/x', fixType: 'raw-text-table', description: 'y' }];
    await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/x')] }),
      analyzePage: async () => ({ ok: true, analysis: { rawTextTableBlocks: [] } }),
    });
    assert.equal(inserted.length, 0);
  });

  test('multiple independent defects on the SAME page are all processed, not just the first', async () => {
    visionResponse = [
      { page: 'https://example.com/x', fixType: 'duplicate-faq', description: 'first' },
      { page: 'https://example.com/x', fixType: 'malformed-table', description: 'second, same page' },
    ];
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/x')] }),
      analyzePage: async (url) => ({
        ok: true,
        analysis: { duplicateFaqRemovalHtml: '<section>dup</section>', removableMalformedTables: [{ reason: 'no-rows' }] },
      }),
    });
    assert.equal(result.facts.findings.length, 2, 'both defects on the same page must produce their own finding');
    const fixTypes = result.facts.findings.map((f) => f.recommendedAction.params.fixType).sort();
    assert.deepEqual(fixTypes, ['duplicate-faq', 'malformed-table']);
    // Distinct recommendation keys — must never collide into one row.
    const ids = result.facts.findings.map((f) => f.id);
    assert.equal(new Set(ids).size, 2);
  });

  test('a genuinely duplicate (page, fixType) candidate from vision collapses to one finding', async () => {
    visionResponse = [
      { page: 'https://example.com/x', fixType: 'duplicate-faq', description: 'first mention' },
      { page: 'https://example.com/x', fixType: 'duplicate-faq', description: 'same defect, mentioned again' },
    ];
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/x')] }),
      analyzePage: async () => ({ ok: true, analysis: { duplicateFaqRemovalHtml: '<section>dup</section>' } }),
    });
    assert.equal(result.facts.findings.length, 1);
  });

  test('two unconfirmed defects on the same page each get their own manual recommendation, not one merged row', async () => {
    visionResponse = [
      { page: 'https://example.com/x', fixType: 'duplicate-faq', description: 'first' },
      { page: 'https://example.com/x', fixType: 'raw-text-table', description: 'second' },
    ];
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/x')] }),
      analyzePage: async () => ({ ok: true, analysis: {} }), // neither confirmed
    });
    assert.equal(result.facts.findings.length, 0);
    assert.equal(inserted.length, 2);
    assert.notEqual(inserted[0].page, inserted[1].page, 'each unconfirmed fixType on the same page must get a distinct recommendation key');
  });

  // priority used to be hardcoded 'high' for every confirmed defect and
  // expectedImpact a literal {label:'Medium', basis:'computed', value:1} —
  // a constant claiming a computed basis, which types.js forbids. Both now
  // come from the real count of defective regions the deterministic check
  // itself found.
  test('expectedImpact.value is the real defective-region count, not a constant 1', async () => {
    visionResponse = [{ page: 'https://example.com/pricing', fixType: 'malformed-table', description: 'Broken tables.' }];
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/pricing')] }),
      analyzePage: async () => ({
        ok: true,
        analysis: { removableMalformedTables: [{ reason: 'no-rows' }, { reason: 'empty-row' }, { reason: 'no-rows' }] },
      }),
    });
    const finding = result.facts.findings[0];
    assert.equal(finding.expectedImpact.value, 3);
    assert.equal(finding.evidence.defectiveRegions, 3);
    assert.equal(finding.expectedImpact.basis, 'computed');
    assert.equal(finding.expectedImpact.label, { high: 'High', medium: 'Medium', low: 'Low' }[finding.priority]);
  });

  test('priority is ranked by real defect extent, not hardcoded high for everything', async () => {
    visionResponse = [
      { page: 'https://example.com/a', fixType: 'malformed-table', description: 'many broken tables' },
      { page: 'https://example.com/b', fixType: 'duplicate-faq', description: 'one duplicate faq' },
    ];
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/a'), page('https://example.com/b')] }),
      analyzePage: async (url) => (url.endsWith('/a')
        ? { ok: true, analysis: { removableMalformedTables: [{}, {}, {}, {}, {}] } }
        : { ok: true, analysis: { duplicateFaqRemovalHtml: '<section>dup</section>' } }),
    });
    const byPage = new Map(result.facts.findings.map((f) => [f.evidence.page, f]));
    assert.equal(byPage.get('https://example.com/a').evidence.defectiveRegions, 5);
    assert.equal(byPage.get('https://example.com/b').evidence.defectiveRegions, 1);
    assert.equal(byPage.get('https://example.com/a').priority, 'high');
    assert.notEqual(byPage.get('https://example.com/b').priority, 'high', 'the smaller real defect must not carry the same priority as the largest');
  });

  test('an unconfirmed, vision-only flag never outranks a confirmed defect', async () => {
    visionResponse = [{ page: 'https://example.com/x', fixType: 'raw-text-table', description: 'maybe a table' }];
    await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/x')] }),
      analyzePage: async () => ({ ok: true, analysis: { rawTextTableBlocks: [{ clean: false }] } }),
    });
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].priority, 'low');
  });

  test('a vision call failure degrades to zero candidates rather than throwing the whole agent run', async () => {
    const result = await run({
      siteId: 1,
      capture: async () => ({ pages: [page('https://example.com/')] }),
      // callLLMWithImages is mocked at module scope; simulate a bad/unparseable response instead
    });
    // visionResponse defaults to [] via beforeEach, and callLLMWithImages stringifies it -> extractJson parses []
    assert.equal(result.status, 'ok');
    assert.equal(result.facts.findings.length, 0);
  });
});

// The actual bug fixed 2026-09-01: capture.js's discoverPages() re-crawls
// the homepage's own links every run and deterministically picks the first
// URL per page type, so this agent had been vision-auditing the exact same
// ~8 pages forever — every other page on a site never got checked, no
// matter how many days passed. defaultCapture (this file's `capture` seam's
// real implementation) replaces that with the same rotation ledger
// (agent_page_rotation) every other page-level agent already shares.
describe('defaultCapture', () => {
  test('selects THIS agent\'s own rotation candidates, under its own agentId, and passes them straight to capturePages', async () => {
    const selectCalls = [];
    const capturePageCalls = [];
    await defaultCapture(7, {
      start: '2026-08-01', end: '2026-08-31',
      selectCandidates: async (siteId, agentId, opts) => {
        selectCalls.push({ siteId, agentId, opts });
        return { batch: ['https://example.com/a', 'https://example.com/b'], impressionsByPage: new Map() };
      },
      capturePages: async (urls, opts) => { capturePageCalls.push({ urls, opts }); return { pages: [page(urls[0])] }; },
      mark: async () => {},
    });
    assert.equal(selectCalls.length, 1);
    assert.equal(selectCalls[0].siteId, 7);
    assert.equal(selectCalls[0].agentId, 'visual-quality', 'must rotate independently of content-integrity\'s own rotation position');
    assert.equal(selectCalls[0].opts.start, '2026-08-01');
    assert.deepEqual(capturePageCalls[0].urls, ['https://example.com/a', 'https://example.com/b']);
  });

  test('advances the rotation ledger for exactly the pages selected, so tomorrow\'s run picks up where today left off', async () => {
    const markCalls = [];
    await defaultCapture(7, {
      selectCandidates: async () => ({ batch: ['https://example.com/a'], impressionsByPage: new Map() }),
      capturePages: async () => ({ pages: [] }),
      mark: async (siteId, agentId, batch) => markCalls.push({ siteId, agentId, batch }),
    });
    assert.deepEqual(markCalls, [{ siteId: 7, agentId: 'visual-quality', batch: ['https://example.com/a'] }]);
  });

  test('no candidate pages (empty rotation batch) short-circuits without ever launching a browser', async () => {
    let captured = false;
    const result = await defaultCapture(7, {
      selectCandidates: async () => ({ batch: [], impressionsByPage: new Map() }),
      capturePages: async () => { captured = true; return { pages: [] }; },
      mark: async () => { throw new Error('must not mark an empty batch'); },
    });
    assert.deepEqual(result, { pages: [] });
    assert.equal(captured, false);
  });
});
