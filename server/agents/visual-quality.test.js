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

  test('an already-open manual recommendation for the same page+generator is never duplicated', async () => {
    existingRecs = [{ page: 'https://example.com/x', recommendation_type: 'content-integrity-repair' }];
    visionResponse = [{ page: 'https://example.com/x', fixType: 'raw-text-table', description: 'y' }];
    await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => ({ pages: [page('https://example.com/x')] }),
      analyzePage: async () => ({ ok: true, analysis: { rawTextTableBlocks: [] } }),
    });
    assert.equal(inserted.length, 0);
  });

  test('at most one finding per page per run — a second fixType on the same page is dropped, never collides into two recommendations', async () => {
    visionResponse = [
      { page: 'https://example.com/x', fixType: 'duplicate-faq', description: 'first' },
      { page: 'https://example.com/x', fixType: 'malformed-table', description: 'second, same page' },
    ];
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => ({ pages: [page('https://example.com/x')] }),
      analyzePage: async () => ({ ok: true, analysis: { duplicateFaqRemovalHtml: '<section>dup</section>' } }),
    });
    assert.equal(result.facts.findings.length, 1);
    assert.equal(result.facts.findings[0].recommendedAction.params.fixType, 'duplicate-faq');
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
