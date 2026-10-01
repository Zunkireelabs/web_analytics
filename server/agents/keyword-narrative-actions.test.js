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
const saves = [];
let connectedSites = [];
let runnerOutput = {};

mock.module(resolve('../store/data-analyst.js'), {
  namedExports: {
    getKeywordGaps: async () => keywordGaps,
    getKeywordClusters: async () => contentClusters,
    getSiteProfile: async () => ({ business_type: 'services' }),
    saveKeywordNarrative: async (...args) => { saves.push(args); return {}; },
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
  namedExports: { listConnectedSites: async () => connectedSites },
});
mock.module(resolve('./runner.js'), {
  namedExports: { runAgent: async () => runnerOutput },
});
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => 'narrative' },
});

const { run, runKeywordNarrativeForAllSites, keywordMatchesQuery } = await import('./keyword-narrative.js');

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


describe('keyword-narrative persistence + matching', () => {
  test('run() itself never writes the dashboard narrative (it cannot know persist)', async () => {
    saves.length = 0;
    keywordGaps = [{ topic: 'x topic', reason: 'r', priority: 'high' }];
    contentClusters = [];
    queryPageMetrics = [];
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'ok');
    assert.ok(result.narrative);
    assert.equal(saves.length, 0);
  });

  test('the persist:true cron path writes it, once, only for an ok run with a narrative', async () => {
    saves.length = 0;
    connectedSites = [{ id: 7, name: 'A' }, { id: 8, name: 'B' }];
    runnerOutput = { status: 'ok', narrative: 'hello' };
    await runKeywordNarrativeForAllSites();
    assert.deepEqual(saves, [[7, 'hello'], [8, 'hello']]);

    saves.length = 0;
    runnerOutput = { status: 'insufficient-data', narrative: null };
    await runKeywordNarrativeForAllSites();
    assert.equal(saves.length, 0);
    connectedSites = [];
  });

  test('keyword matching is token-based: reorderings, plurals and extended variants match; single-word keywords stay strict', () => {
    assert.equal(keywordMatchesQuery('study in uk', 'uk study in'), true);
    assert.equal(keywordMatchesQuery('student visa', 'student visas'), true);
    assert.equal(keywordMatchesQuery('student visa', 'student visa requirements uk'), true);
    assert.equal(keywordMatchesQuery('visa', 'student visa uk'), false);
    assert.equal(keywordMatchesQuery('visa', 'visa'), true);
    assert.equal(keywordMatchesQuery('uk visa', 'ukraine visa'), false);
  });

  test('a cluster whose traffic lands on a real page via a variant query is NOT reported as a missing topic', async () => {
    keywordGaps = [];
    contentClusters = [{ cluster_name: 'uk study', cluster_type: 'topic', gap_score: 5, avg_position: 20, avg_impressions: 100, keywords_json: [{ keyword: 'study in uk' }] }];
    queryPageMetrics = [{ query: 'uk study in', page: 'https://example.com/uk', clicks: 3, impressions: 50, avgPosition: 12 }];
    const findings = await findingsFor();
    const f = findings.find((x) => x.id.startsWith('keyword-narrative:cluster:'));
    assert.equal(f.recommendedAction.generatorId, 'expand-content');
  });
});
