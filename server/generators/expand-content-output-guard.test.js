import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// expand-content's own pre-ship defence: a draft whose comparison table is
// filler (unnamed "Alternative" column, hedged cells) is regenerated ONCE with
// the exact correction, and held (refusal, needs attention) if it fails again.
const resolve = (p) => new URL(p, import.meta.url).href;

let llmCalls;
let llmQueue;

mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLMForJson: async (_system, user) => { llmCalls.push(user); return llmQueue.shift(); },
  },
});
mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: {
    analyzePageUrl: async () => ({ ok: true, analysis: { title: 'Doc search', bodyText: 'Real body text about document search and retrieval.' } }),
    requireGroundedContent: () => {},
  },
});
mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async () => ({ id: 1, website_domain: 'example.com' }) } });
mock.module(resolve('./lib/expand-content-structural-fit.js'), { namedExports: { checkExpandContentStructuralFit: async () => null } });
mock.module(resolve('../lib/tenant-context.js'), { namedExports: { tenantContextTextFor: async () => '' } });
mock.module(resolve('../agents/lib/zunkireelabs-growth-policy.js'), { namedExports: { attributionNote: () => '' } });
mock.module(resolve('../design-agent/lib/expand-structure-loader.js'), { namedExports: { loadExpandStructurePrior: async () => null } });
mock.module(resolve('../design-agent/lib/expand-structure-spec.js'), { namedExports: { structurePlanText: () => '' } });
mock.module(resolve('../design-agent/live-analysis/schema.js'), { namedExports: { classifyPageType: () => 'blog' } });
mock.module(resolve('../agents/lib/competitor-policy.js'), { namedExports: { filterCompetitorCandidates: async (items) => ({ allowed: items, removed: [] }) } });
mock.module(resolve('../ingest/search-grounding-providers/index.js'), {
  namedExports: { groundingProviderConfigured: () => false, searchGroundedSources: async () => [], queryTokens: () => [] },
});

const { generate } = await import('./expand-content.js');

const FILLER = [{
  heading: 'Competitors for document search', body: 'Compare the options.',
  table: [
    { feature: 'Document types', this_option: 'PDF, DOCX, HTML', alternative: 'Focus may be on specific document types' },
    { feature: 'Setup', this_option: 'Minutes', alternative: 'May require more configuration' },
  ],
}];
const GOOD = [{ heading: 'Why retrieval quality matters', body: 'Grounded prose about retrieval quality in the page.' }];

beforeEach(() => { llmCalls = []; llmQueue = []; });

describe('expand-content — output guard', () => {
  test('a filler comparison is regenerated once with the correction, and the clean retry ships', async () => {
    llmQueue = [FILLER, GOOD];
    const { content } = await generate({ siteId: 1, params: { page: 'https://example.com/a', query: 'doc search', focus: 'comparison-content' } });
    assert.equal(llmCalls.length, 2);
    assert.match(llmCalls[1], /previous draft was rejected/);
    assert.match(llmCalls[1], /unnamed/);
    assert.equal(content.sections[0].heading, 'Why retrieval quality matters');
  });

  test('a draft that fails twice is held, never shipped', async () => {
    llmQueue = [FILLER, FILLER];
    await assert.rejects(
      generate({ siteId: 1, params: { page: 'https://example.com/a', query: 'doc search', focus: 'comparison-content' } }),
      (err) => err.refusal === true && err.reason === 'output-guard-failed',
    );
    assert.equal(llmCalls.length, 2, 'exactly one retry, no loop');
  });

  test('a clean first draft costs a single model call', async () => {
    llmQueue = [GOOD];
    await generate({ siteId: 1, params: { page: 'https://example.com/a', query: 'doc search' } });
    assert.equal(llmCalls.length, 1);
  });
});
