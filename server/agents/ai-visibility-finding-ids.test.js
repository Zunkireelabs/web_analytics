import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

// Only the live-fetch / DB / LLM edges are stubbed; visibility-score.js and
// findings.js run for real, so the ids under test are built from real scores.
mock.module(resolve('./lib/page-content.js'), {
  namedExports: {
    analyzePageUrl: async () => ({
      ok: true,
      analysis: {
        schemaTypes: [], h1Count: 0, h2Count: 0, listCount: 0, tableCount: 0,
        hasFaqSchema: false, hasFaqHeading: false, questionHeadingCount: 0,
        hasAuthorSignal: false, hasComparisonContent: false, hasFreshnessSignal: false,
      },
    }),
    checkLlmsReadiness: async () => ({ hasLlmsTxt: true, hasValidLlmsTxtStructure: true, hasRobotsTxt: true, robotsAllowsAiCrawlers: true }),
    checkWebMcpPresence: async () => ({ hasManifest: true }),
    effortForGenerator: () => 'Medium',
    inferSchemaType: () => 'Article',
  },
});
mock.module(resolve('../store/read.js'), {
  namedExports: { getQueriesForPage: async () => [{ query: 'roof repair' }] },
});
mock.module(resolve('./lib/candidate-pages.js'), {
  namedExports: { selectCandidatePages: async () => ({ batch: [], impressionsByPage: new Map() }), markPagesChecked: async () => {} },
});
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => 'narrative' },
});

const { run, recommendationsFor } = await import('./ai-visibility.js');

describe('ai-visibility finding ids', () => {
  // The bug: the id embedded the human-readable rule label, so rewording a
  // recommendation — even fixing a typo — re-issued every finding of that
  // kind under a new id, breaking dedupe against the already-open
  // recommendation and starting that page's fix history over.
  test('the id carries the stable rule key, never the label prose', async () => {
    const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-28', params: { pages: ['https://example.com/p'] } });
    const ids = result.facts.findings.map((f) => f.id);
    assert.equal(ids.includes('ai-visibility:add-faq:https://example.com/p'), true);
    for (const id of ids) {
      assert.equal(/[A-Z]|\. |\.$/.test(id.replace('https://', '')), false, `finding id must not contain label prose: ${id}`);
    }
  });

  test('every rule exposes a key, and the keys are unique', () => {
    // Categories chosen so every rule fires at once.
    const recs = recommendationsFor({ schema: 0, structuredContent: 0, faq: 60, entities: 0, citationReadiness: 0 });
    assert.equal(recs.length > 1, true);
    for (const rec of recs) assert.equal(typeof rec.key, 'string');
    assert.equal(new Set(recs.map((r) => r.key)).size, recs.length);
  });

  // Two rules draft via 'faq' and two via 'schema', so generatorId alone
  // could never have served as the stable key.
  test('rules that share a generatorId still get distinct keys', () => {
    const faqSchemaRule = recommendationsFor({ schema: 100, structuredContent: 100, faq: 60, entities: 100, citationReadiness: 100 });
    const addFaqRule = recommendationsFor({ schema: 100, structuredContent: 100, faq: 0, entities: 100, citationReadiness: 100 });
    assert.equal(faqSchemaRule[0].generatorId, 'faq');
    assert.equal(addFaqRule[0].generatorId, 'faq');
    assert.notEqual(faqSchemaRule[0].key, addFaqRule[0].key);
  });
});
