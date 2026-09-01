import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

let discovery;

// Everything this agent talks to that isn't pure logic — the DB, the SERP
// provider, the Common Crawl comparison, the narrative LLM — is stubbed, so
// what's under test is only how a discovered competitor becomes a Finding.
mock.module(resolve('./lib/competitor-analysis.js'), {
  namedExports: {
    runCompetitorDiscovery: async () => discovery,
    normalizeCompetitorDomain: (d) => d || null,
    isKnownPlatformDomain: () => false,
  },
});
mock.module(resolve('./lib/competitor-backlinks.js'), {
  namedExports: { buildBacklinkComparison: async () => ({ status: 'insufficient-data' }) },
});
mock.module(resolve('../store/competitor-profiles.js'), {
  namedExports: {
    upsertCompetitorProfile: async () => ({}),
    insertCompetitorStructuralSnapshot: async () => ({}),
  },
});
mock.module(resolve('../store/read.js'), {
  namedExports: {
    getCompetitorRankingDates: async () => [],
    getCompetitorRankingsOn: async () => [],
    getSearchPerformanceRange: async () => [],
  },
});
mock.module(resolve('../ingest/competitor-providers/index.js'), {
  namedExports: {
    getCompetitorProvider: () => ({ id: 'none' }),
    competitorProviderConfigured: () => false,
  },
});
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => 'narrative' },
});

const { run } = await import('./competitor-intelligence.js');

function competitor(domain, { source = 'llm', ownScore = 50, competitorScore = 70, overlapCount = 0 } = {}) {
  return {
    domain, ok: true, ownScore, competitorScore, discoverySource: source,
    queryOverlap: { queriesChecked: 4, overlapCount, matchedQueries: overlapCount ? ['roof repair'] : [] },
    comparison: {
      positioning: 'LLM PROSE positioning', contentDepth: 'LLM PROSE depth',
      seoStructure: 'LLM PROSE structure', aiVisibility: 'LLM PROSE ai', verdict: 'LLM PROSE verdict',
      structuralSignals: { hasFaq: true, hasSchema: false, hasComparisonContent: false },
    },
  };
}

beforeEach(() => { discovery = { ownDomain: 'ownsite.com', ownScore: 50, competitors: [] }; });

describe('competitor-intelligence discovery findings', () => {
  // The bug: `...c.comparison` spread the whole parsed LLM object into
  // Finding.evidence, so free-text model commentary was presented to a
  // customer in the field types.js reserves for real numbers.
  test('LLM commentary never reaches Finding.evidence', async () => {
    discovery.competitors = [competitor('rival.com')];
    const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-28' });
    const finding = result.facts.findings.find((f) => f.id === 'competitor-intelligence:discovery:rival.com');
    const evidenceJson = JSON.stringify(finding.evidence);
    assert.equal(evidenceJson.includes('LLM PROSE'), false, 'no model prose may appear in evidence');
    for (const prosaicField of ['positioning', 'contentDepth', 'seoStructure', 'aiVisibility', 'verdict']) {
      assert.equal(prosaicField in finding.evidence, false, `${prosaicField} is commentary, not evidence`);
    }
    // ...but the real numbers are all still there.
    assert.equal(finding.evidence.ownScore, 50);
    assert.equal(finding.evidence.competitorScore, 70);
    assert.equal(finding.evidence.scoreGap, 20);
    assert.equal(finding.evidence.queriesChecked, 4);
    // The prose is still available where prose belongs.
    assert.equal(result.facts.comparisons[0].verdict, 'LLM PROSE verdict');
  });

  test('an unverified, LLM-named competitor says so in whyItMatters', async () => {
    discovery.competitors = [competitor('rival.com', { source: 'llm' })];
    const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-28' });
    const finding = result.facts.findings[0];
    assert.equal(finding.evidence.serpVerified, false);
    assert.match(finding.whyItMatters, /AI market-research reasoning, not confirmed by any real ranking data/);
    assert.equal(finding.expectedImpact.basis, 'estimate');
  });

  // Evidence strength before magnitude: an ungrounded guess must never be
  // presented as this site's most urgent competitive threat just because its
  // structural score happens to be higher.
  test('a SERP-confirmed competitor outranks an ungrounded LLM guess with a bigger score gap', async () => {
    discovery.competitors = [
      competitor('guess.com', { source: 'llm', competitorScore: 100, overlapCount: 0 }),
      competitor('real.com', { source: 'serp', competitorScore: 55 }),
    ];
    const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-28' });
    const byDomain = new Map(result.facts.findings.map((f) => [f.evidence.domain, f]));
    assert.equal(byDomain.get('real.com').priority, 'high');
    assert.equal(byDomain.get('guess.com').priority, 'low');
    assert.equal(byDomain.get('real.com').evidence.serpVerified, true);
  });

  // Among LLM-only candidates, the free query-overlap grounding is the only
  // real signal available — it must actually be used.
  test('among LLM-only candidates, real query overlap outranks none', async () => {
    discovery.competitors = [
      competitor('irrelevant.com', { source: 'llm', competitorScore: 90, overlapCount: 0 }),
      competitor('relevant.com', { source: 'llm', competitorScore: 55, overlapCount: 3 }),
    ];
    const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-28' });
    const byDomain = new Map(result.facts.findings.map((f) => [f.evidence.domain, f]));
    assert.equal(byDomain.get('relevant.com').priority, 'high');
    assert.equal(byDomain.get('irrelevant.com').priority, 'low');
  });

  test('priority is not a fixed constant across differently-evidenced competitors', async () => {
    discovery.competitors = [
      competitor('a.com', { source: 'both', overlapCount: 2 }),
      competitor('b.com', { source: 'serp' }),
      competitor('c.com', { source: 'llm', overlapCount: 0 }),
    ];
    const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-28' });
    const priorities = result.facts.findings.map((f) => f.priority);
    assert.equal(new Set(priorities).size > 1, true);
  });
});
