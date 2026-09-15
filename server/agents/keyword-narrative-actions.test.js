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
let queryPageMetrics;

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
mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSiteById: async () => ({ id: 1, timezone: 'UTC' }),
    getQueryPageMetrics: async () => queryPageMetrics,
    // Unused by this module directly, but lib/duplicate-evidence.js (which
    // keyword-narrative.js now imports evidenceWindow from) imports it from
    // the same module — module mocking replaces the whole export set.
    getSearchPerformanceForPages: async () => [],
  },
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
    queryPageMetrics = [];

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
    queryPageMetrics = [];

    const findings = await findingsFor();
    const gap = findings.find((f) => f.id.startsWith('keyword-narrative:gap:'));

    assert.equal(gap.recommendedAction.generatorId, 'blog-outline');
    assert.ok(gap.recommendedAction.params.context.length > 0);
  });
});

describe('keyword-cluster-gap — page-aware routing, no editorial dead end', () => {
  test('no real Search Console data yet -> honest insufficient-evidence reportOnly, never guesses', async () => {
    keywordGaps = [];
    contentClusters = [{
      cluster_name: 'pricing', cluster_type: 'topic', gap_score: 90, avg_position: 34.2, avg_impressions: 500,
      keywords_json: [{ keyword: 'venue pricing' }],
    }];
    queryPageMetrics = [];

    const findings = await findingsFor();
    const cluster = findings.find((f) => f.id.startsWith('keyword-narrative:cluster:'));

    assert.equal(cluster.recommendedAction, null);
    assert.equal(cluster.reportOnly.kind, 'keyword-cluster-gap');
    assert.match(cluster.reportOnly.whyBlocked, /insufficient|no real Search Console/i);
  });

  test('zero pages match the cluster\'s own keywords -> genuinely missing topic -> blog-outline', async () => {
    keywordGaps = [];
    contentClusters = [{
      cluster_name: 'pricing', cluster_type: 'topic', gap_score: 90, avg_position: null, avg_impressions: 500,
      keywords_json: [{ keyword: 'venue pricing' }],
    }];
    // Real site-wide GSC data exists, but none of it is for this cluster's
    // own keyword — so this really is an uncovered topic, not thin data.
    queryPageMetrics = [{ query: 'unrelated other query', page: '/other/', clicks: 5, impressions: 50, avgPosition: 8 }];

    const findings = await findingsFor();
    const cluster = findings.find((f) => f.id.startsWith('keyword-narrative:cluster:'));

    assert.equal(cluster.recommendedAction.generatorId, 'blog-outline');
    assert.equal(cluster.recommendedAction.params.topic, 'pricing');
    assert.equal(cluster.reportOnly, undefined);
  });

  test('exactly one real page already owns the cluster\'s traffic -> expand-content on that page', async () => {
    keywordGaps = [];
    contentClusters = [{
      cluster_name: 'pricing', cluster_type: 'topic', gap_score: 90, avg_position: 34.2, avg_impressions: 500,
      keywords_json: [{ keyword: 'venue pricing' }, { keyword: 'wedding venue cost' }],
    }];
    queryPageMetrics = [
      { query: 'venue pricing', page: '/pricing/', clicks: 3, impressions: 200, avgPosition: 22 },
      { query: 'wedding venue cost', page: '/pricing/', clicks: 1, impressions: 150, avgPosition: 30 },
    ];

    const findings = await findingsFor();
    const cluster = findings.find((f) => f.id.startsWith('keyword-narrative:cluster:pricing'));

    assert.equal(cluster.recommendedAction.generatorId, 'expand-content');
    assert.equal(cluster.recommendedAction.params.page, '/pricing/');
  });

  test('2+ real pages independently compete for the cluster\'s keywords -> evidence-scored winner -> internal-links on the loser(s)', async () => {
    keywordGaps = [];
    contentClusters = [{
      cluster_name: 'pricing', cluster_type: 'topic', gap_score: 90, avg_position: 12, avg_impressions: 500,
      keywords_json: [{ keyword: 'venue pricing' }],
    }];
    queryPageMetrics = [
      { query: 'venue pricing', page: '/pricing/', clicks: 40, impressions: 300, avgPosition: 5 },
      { query: 'venue pricing', page: '/venues/pricing-guide/', clicks: 5, impressions: 100, avgPosition: 15 },
    ];

    const findings = await findingsFor();
    const clusterFindings = findings.filter((f) => f.id.startsWith('keyword-narrative:cluster:pricing'));

    assert.equal(clusterFindings.length, 1); // one finding per loser page
    const finding = clusterFindings[0];
    assert.equal(finding.recommendedAction.generatorId, 'internal-links');
    assert.equal(finding.recommendedAction.params.mustLinkTo, '/pricing/'); // stronger real evidence wins
    assert.equal(finding.recommendedAction.params.page, '/venues/pricing-guide/');
  });
});
