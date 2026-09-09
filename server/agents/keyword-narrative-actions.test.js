import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

// A keyword gap names a topic this site has no page for — exactly what
// generators/blog-outline.js drafts, and exactly what content-gap.js already
// routes its own gaps through. This agent claimed no such generator existed
// and left every gap actionless, so the analyst's keyword gaps were computed,
// stored, and read by nobody.

let keywordGaps;
let contentClusters;

mock.module(resolve('../store/data-analyst.js'), {
  namedExports: {
    getKeywordGaps: async () => keywordGaps,
    getKeywordClusters: async () => contentClusters,
    getSiteProfile: async () => ({ business_type: 'services' }),
    saveKeywordNarrative: async () => ({}),
  },
});
mock.module(resolve('../store/agent-runs.js'), {
  namedExports: { getLatestAgentRuns: async () => [] },
});
mock.module(resolve('../job.js'), {
  namedExports: { listConnectedSites: async () => [] },
});
mock.module(resolve('./runner.js'), {
  namedExports: { runAgent: async () => ({}) },
});
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => 'narrative' },
});

const { run } = await import('./keyword-narrative.js');

const findingsFor = async () => {
  const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-28' });
  return result.facts?.findings || result.findings || [];
};

describe('keyword-narrative produces actionable gaps', () => {
  test('a keyword gap routes to the blog-outline generator with real context', async () => {
    keywordGaps = [{ topic: 'destination weddings', reason: 'competitors rank for it', priority: 'high' }];
    contentClusters = [];

    const findings = await findingsFor();
    const gap = findings.find((f) => f.id.startsWith('keyword-narrative:gap:'));

    assert.equal(gap.recommendedAction.generatorId, 'blog-outline');
    assert.equal(gap.recommendedAction.params.topic, 'destination weddings');
    // The generator gets the stored reason, not a bare keyword, so the draft
    // is grounded in why the gap was flagged.
    assert.match(gap.recommendedAction.params.context, /competitors rank for it/);
    assert.equal(gap.priority, 'high');
  });

  test('a gap with no stored reason still produces a usable context', async () => {
    keywordGaps = [{ topic: 'venue pricing', reason: null, priority: 'medium' }];
    contentClusters = [];

    const findings = await findingsFor();
    const gap = findings.find((f) => f.id.startsWith('keyword-narrative:gap:'));

    assert.equal(gap.recommendedAction.generatorId, 'blog-outline');
    assert.ok(gap.recommendedAction.params.context.length > 0);
  });

  test('a poorly-ranking cluster stays human-owned but visible', async () => {
    keywordGaps = [];
    contentClusters = [{ name: 'pricing', type: 'topic', gap_score: 90, avg_position: 34.2, avg_impressions: 500 }];

    const findings = await findingsFor();
    const cluster = findings.find((f) => f.id.startsWith('keyword-narrative:cluster:'));

    // Drafting a net-new post here would compete with the site's own existing
    // pages on that topic — the fix is strengthening them, which is a call a
    // person makes.
    assert.equal(cluster.recommendedAction, null);
    assert.equal(cluster.reportOnly.kind, 'keyword-cluster-gap');
    assert.match(cluster.reportOnly.whyBlocked, /strengthening the existing pages/);
  });
});
