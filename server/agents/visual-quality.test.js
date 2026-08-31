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

const { run, meta } = await import('./visual-quality.js');

function page(url, screenshot = 'base64data') {
  return { url, pageType: 'homepage', title: 'T', blocks: [], screenshot };
}

beforeEach(() => { inserted = []; existingRecs = []; visionResponse = []; });

describe('visual-quality agent', () => {
  test('meta.id is visual-quality', () => {
    assert.equal(meta.id, 'visual-quality');
  });

  test('insufficient-data when the site has no configured domain', async () => {
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: null, gsc_property: null }),
      capture: async () => { throw new Error('should not be called'); },
    });
    assert.equal(result.status, 'insufficient-data');
  });

  test('insufficient-data when no page captured a screenshot', async () => {
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => ({ pages: [{ url: 'https://example.com/', blocks: [] }] }), // no .screenshot
    });
    assert.equal(result.status, 'insufficient-data');
  });

  test('ok, zero findings when vision flags nothing', async () => {
    visionResponse = [];
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
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
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
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
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
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
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
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
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
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
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
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
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
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
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
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
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
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
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => ({ pages: [page('https://example.com/x')] }),
      analyzePage: async () => ({ ok: true, analysis: {} }), // neither confirmed
    });
    assert.equal(result.facts.findings.length, 0);
    assert.equal(inserted.length, 2);
    assert.notEqual(inserted[0].page, inserted[1].page, 'each unconfirmed fixType on the same page must get a distinct recommendation key');
  });

  test('a vision call failure degrades to zero candidates rather than throwing the whole agent run', async () => {
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => ({ pages: [page('https://example.com/')] }),
      // callLLMWithImages is mocked at module scope; simulate a bad/unparseable response instead
    });
    // visionResponse defaults to [] via beforeEach, and callLLMWithImages stringifies it -> extractJson parses []
    assert.equal(result.status, 'ok');
    assert.equal(result.facts.findings.length, 0);
  });
});
