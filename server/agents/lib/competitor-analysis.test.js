import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

let fetchedAnalysis;
let comparisonJson;

// page-content.js's real analyzePageUrl does live HTTP; llm.js does a real
// API call. Both are mocked so the grounding logic under test is exercised
// on its own, same discipline as visual-quality.test.js.
mock.module(resolve('./page-content.js'), {
  namedExports: { analyzePageUrl: async () => fetchedAnalysis },
});
mock.module(resolve('../../llm.js'), {
  namedExports: { callLLM: async () => comparisonJson },
});

const { queryRelevanceOverlap, analyzeCompetitor } = await import('./competitor-analysis.js');

describe('queryRelevanceOverlap — free relevance grounding', () => {
  const analysis = {
    title: 'Acme Roofing — Roof Repair in Denver',
    metaDescription: 'Emergency roof repair and gutter cleaning.',
    bodyText: 'We handle roof repair, gutter cleaning and shingle replacement across Denver.',
  };

  test('counts only queries whose every topical term really appears on the page', () => {
    const overlap = queryRelevanceOverlap(analysis, ['roof repair denver', 'wedding photography'], 'ownsite.com');
    assert.equal(overlap.queriesChecked, 2);
    assert.equal(overlap.overlapCount, 1);
    assert.deepEqual(overlap.matchedQueries, ['roof repair denver']);
  });

  test('a real but entirely irrelevant company scores zero overlap', () => {
    const unrelated = { title: 'Global Freight Logistics', metaDescription: '', bodyText: 'Container shipping and customs brokerage.' };
    const overlap = queryRelevanceOverlap(unrelated, ['roof repair denver', 'gutter cleaning'], 'ownsite.com');
    assert.equal(overlap.overlapCount, 0);
    assert.equal(overlap.queriesChecked, 2);
  });

  // Without this, every genuine competitor would score zero: a competitor's
  // homepage never contains this site's own brand name.
  test('the site\'s own brand terms are stripped from queries before testing', () => {
    const overlap = queryRelevanceOverlap(analysis, ['acmeroofing gutter cleaning'], 'acmeroofing.com');
    assert.equal(overlap.overlapCount, 1);
  });

  // queriesChecked === 0 is how the caller knows the overlap number carries
  // no information — an unanswerable test, not a failed one.
  test('a pure brand query is not counted as checked at all', () => {
    const overlap = queryRelevanceOverlap(analysis, ['acmeroofing'], 'acmeroofing.com');
    assert.equal(overlap.queriesChecked, 0);
    assert.equal(overlap.overlapCount, 0);
  });
});

describe('analyzeCompetitor', () => {
  test('returns queryOverlap as its own real field, kept out of the LLM comparison object', async () => {
    fetchedAnalysis = {
      ok: true,
      analysis: {
        title: 'Rival Roofing', metaDescription: '', bodyText: 'roof repair in denver',
        schemaTypes: ['Organization'], hasFaq: true, hasSchema: true, hasComparisonContent: false,
        h1Count: 1, h2Count: 3, listCount: 1, tableCount: 0, wordCount: 900,
        hasFaqSchema: true, hasFaqHeading: true, questionHeadingCount: 3, internalLinkCount: 12,
      },
    };
    comparisonJson = JSON.stringify({
      positioning: 'model prose', contentDepth: 'model prose', seoStructure: 'model prose',
      aiVisibility: 'model prose', verdict: 'model prose',
    });

    const result = await analyzeCompetitor('rival.com', fetchedAnalysis.analysis, 'ownsite.com', 60, ['roof repair denver']);
    assert.equal(result.ok, true);
    assert.equal(result.queryOverlap.overlapCount, 1);
    // structuralSignals stays inside `comparison` — content-gap.js reads it
    // from the persisted profile at exactly that path.
    assert.equal(typeof result.comparison.structuralSignals.hasFaq, 'boolean');
    assert.equal(result.comparison.queryOverlap, undefined);
  });
});
