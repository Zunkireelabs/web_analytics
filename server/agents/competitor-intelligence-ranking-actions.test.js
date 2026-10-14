import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

// Covers what a competitor RANKING finding becomes downstream. Until
// 2026-09-09 every one of them had a null recommendedAction and no
// reportOnly, so buildRecommendations discarded the lot — a query with real
// search demand that this site does not rank for at all was detected on every
// run and reached nobody.
//
// The two situations are genuinely different and must not collapse into one:
// absent from the top 20 is a content gap (draftable); present but lower is
// an existing page to strengthen against a named competitor (not draftable).

let latestRows;
let perfRows;

mock.module(resolve('./lib/competitor-analysis.js'), {
  namedExports: {
    runCompetitorDiscovery: async () => ({ competitors: [], ownDomain: 'example.com' }),
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
    getCompetitorRankingDates: async () => ['2026-09-01'],
    getCompetitorRankingsOn: async () => latestRows,
    getSearchPerformanceRange: async () => perfRows,
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

// facts is null on the agent's own insufficient-data path (no competitors
// discovered and nothing worth reporting) — a legitimate outcome here, since
// these tests stub discovery out entirely and drive only the ranking rows.
const rankingFindings = async () => {
  const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-28' });
  return (result.facts?.findings || []).filter((f) => f.id.startsWith('competitor-intelligence:ranking:'));
};

describe('competitor ranking findings become real actions', () => {
  beforeEach(() => {
    perfRows = [{ dim_value: 'wedding venues goa', impressions: 400 }];
  });

  test('a query this site does not rank for at all becomes a drafted content gap', async () => {
    latestRows = [
      { query: 'wedding venues goa', domain: 'rival.com', position: 3, is_own_domain: false },
    ];

    const [finding] = await rankingFindings();

    assert.equal(finding.recommendedAction.generatorId, 'blog-outline');
    assert.equal(finding.recommendedAction.params.topic, 'wedding venues goa');
    // The context handed to the generator carries the real evidence, so the
    // draft is grounded in why this topic matters rather than a bare keyword.
    assert.match(finding.recommendedAction.params.context, /does not appear in the top 20/);
    assert.match(finding.recommendedAction.params.context, /rival\.com ranks #3/);
    // Not both: a draftable finding must never also carry a report-only row,
    // or the same gap would surface twice under two recommendation types.
    assert.equal(finding.reportOnly, null);
  });

  test('a query where this site ranks lower stays human-owned but visible', async () => {
    latestRows = [
      { query: 'wedding venues goa', domain: 'rival.com', position: 2, is_own_domain: false },
      { query: 'wedding venues goa', domain: 'example.com', position: 9, is_own_domain: true },
    ];

    const [finding] = await rankingFindings();

    // A page already exists — drafting a net-new post for a topic the site
    // already covers would compete with its own page.
    assert.equal(finding.recommendedAction, null);
    assert.equal(finding.reportOnly.kind, 'competitor-outranking');
    assert.match(finding.reportOnly.whyBlocked, /strengthening the existing page/);
  });

  test('a query below the impressions floor produces no finding either way', async () => {
    perfRows = [{ dim_value: 'wedding venues goa', impressions: 1 }];
    latestRows = [
      { query: 'wedding venues goa', domain: 'rival.com', position: 3, is_own_domain: false },
    ];

    assert.deepEqual(await rankingFindings(), []);
  });
});
