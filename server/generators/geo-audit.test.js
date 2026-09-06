import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// geo-audit.js's production import chain reaches server/db.js, which fails
// fast at import time if DATABASE_URL is unset — a real, intentional safety
// check we don't want to weaken. A placeholder value here satisfies it
// without ever connecting: pg.Pool only dials lazily on the first real
// query, and nothing in this file issues one — `meta` is a static object,
// and all the real report-building logic below is tested directly against
// buildGeoAuditReport (../agents/lib/geo-audit-report.js), which has no
// DB/network imports at all. Dynamic import (not a static one) is required
// so this assignment runs before geo-audit.js is loaded — static imports
// are hoisted above all other module-body code in ESM.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { meta } = await import('./geo-audit.js');
const { buildGeoAuditReport } = await import('../agents/lib/geo-audit-report.js');

describe('geo-audit generator meta', () => {
  test('has correct id', () => {
    assert.equal(meta.id, 'geo-audit');
  });

  test('has name', () => {
    assert.equal(meta.name, 'GEO Audit Generator');
  });

  test('has description', () => {
    assert.ok(meta.description.length > 0);
  });

  test('has recommendationTags', () => {
    assert.ok(Array.isArray(meta.recommendationTags));
    assert.ok(meta.recommendationTags.length > 0);
  });
});

// A page with every real signal present — should score high and generate
// none of the five GEO-signal "add this" findings.
const strongAnalysis = {
  schemaTypes: ['Article', 'Organization', 'Person'],
  h1Count: 1,
  h2Count: 3,
  listCount: 1,
  tableCount: 0,
  hasFaqSchema: true,
  hasFaqHeading: true,
  questionHeadingCount: 4,
  hasAuthorSignal: true,
  hasFreshnessSignal: true,
  hasComparisonContent: true,
  hasExternalCitations: true,
  hasReviewSchema: true,
};

// A page with none of the real signals — should score low and generate
// every applicable finding, including all five GEO-signal ones.
const weakAnalysis = {
  schemaTypes: [],
  h1Count: 0,
  h2Count: 0,
  listCount: 0,
  tableCount: 0,
  hasFaqSchema: false,
  hasFaqHeading: false,
  questionHeadingCount: 0,
  hasAuthorSignal: false,
  hasFreshnessSignal: false,
  hasComparisonContent: false,
  hasExternalCitations: false,
  hasReviewSchema: false,
};

const llmsReadiness = { hasLlmsTxt: true, hasRobotsTxt: true, robotsAllowsAiCrawlers: true };
const GEO_SIGNAL_LABEL_PATTERN = /author\/byline|freshness|comparison, alternatives|external authoritative sources|Review or AggregateRating/;

describe('buildGeoAuditReport', () => {
  const fetched = [
    { page: 'https://example.com/strong', result: { ok: true, analysis: strongAnalysis }, topQuery: 'strong query', impressions: 500 },
    { page: 'https://example.com/weak', result: { ok: true, analysis: weakAnalysis }, topQuery: 'weak query', impressions: 100 },
  ];

  test('computes a real overall score with all seven categories', () => {
    const { content } = buildGeoAuditReport({ siteName: 'Test Site', start: '2026-05-01', end: '2026-08-01', fetched, llmsReadiness });
    assert.equal(content.pagesAnalyzed, 2);
    assert.equal(typeof content.score.overall, 'number');
    assert.deepEqual(
      Object.keys(content.score.categories).sort(),
      ['citationReadiness', 'entities', 'faq', 'geoSignals', 'llmsReadiness', 'schema', 'structuredContent'].sort()
    );
  });

  test('markdown report includes every expected section', () => {
    const { content } = buildGeoAuditReport({ siteName: 'Test Site', start: '2026-05-01', end: '2026-08-01', fetched, llmsReadiness });
    for (const heading of [
      '# GEO Audit: Test Site',
      '## Overall AI Visibility Score',
      '## Crawlability & AI-Crawler Access',
      '## Top Pages by Urgency',
      '## Recommended Actions',
      '## Summary',
    ]) {
      assert.ok(content.report.includes(heading), `missing "${heading}"`);
    }
    assert.ok(content.report.includes('✅ llms.txt present and robots.txt allows AI crawlers.'));
  });

  test('findings are real structured Finding objects mapped to real generators', () => {
    const { content } = buildGeoAuditReport({ siteName: 'Test Site', start: '2026-05-01', end: '2026-08-01', fetched, llmsReadiness });
    assert.ok(content.findings.length > 0);
    for (const f of content.findings) {
      assert.ok(['high', 'medium', 'low'].includes(f.priority));
      assert.ok(['schema', 'faq', 'expand-content', 'qa-content'].includes(f.recommendedAction.generatorId));
      assert.equal(typeof f.recommendedAction.label, 'string');
      assert.ok(f.recommendedAction.params.page);
      assert.equal(typeof f.whyItMatters, 'string');
    }
  });

  test('a page with every real signal present gets none of the five GEO-signal findings', () => {
    const { content } = buildGeoAuditReport({ siteName: 'Test Site', start: '2026-05-01', end: '2026-08-01', fetched, llmsReadiness });
    const strongFindings = content.findings.filter((f) => f.evidence.page === 'https://example.com/strong');
    assert.ok(!strongFindings.some((f) => GEO_SIGNAL_LABEL_PATTERN.test(f.recommendedAction.label)),
      'a page with author/freshness/comparison/citation/review signals present should not be told to add them');
  });

  test('a page missing every real signal gets all five GEO-signal findings', () => {
    const { content } = buildGeoAuditReport({ siteName: 'Test Site', start: '2026-05-01', end: '2026-08-01', fetched, llmsReadiness });
    const weakFindings = content.findings.filter((f) => f.evidence.page === 'https://example.com/weak');
    const weakLabels = weakFindings.map((f) => f.recommendedAction.label);
    assert.ok(weakLabels.some((l) => l.includes('author/byline')));
    assert.ok(weakLabels.some((l) => l.includes('freshness') || l.includes('last-updated')));
    assert.ok(weakLabels.some((l) => l.includes('comparison, alternatives')));
    assert.ok(weakLabels.some((l) => l.includes('external authoritative sources')));
    assert.ok(weakLabels.some((l) => l.includes('Review or AggregateRating')));
  });

  test('the weakest, highest-traffic page gets high priority', () => {
    const { content } = buildGeoAuditReport({ siteName: 'Test Site', start: '2026-05-01', end: '2026-08-01', fetched, llmsReadiness });
    const weakFindings = content.findings.filter((f) => f.evidence.page === 'https://example.com/weak');
    assert.ok(weakFindings.every((f) => f.priority === 'high'));
  });

  test('no llmsReadiness data — no crash, no score, honest crawlability warning', () => {
    const { content } = buildGeoAuditReport({
      siteName: 'No LLMs Site', start: '2026-05-01', end: '2026-08-01',
      fetched: [{ page: 'https://example.com/x', result: { ok: true, analysis: strongAnalysis }, topQuery: 'q', impressions: 50 }],
      llmsReadiness: null,
    });
    assert.equal(content.score, null);
    assert.equal(content.pagesAnalyzed, 0);
    assert.equal(content.findings.length, 0);
    assert.ok(content.report.includes('Could not check llms.txt / robots.txt readiness.'));
  });

  test('a page that failed to fetch is excluded, not crashed on', () => {
    const { content, summary } = buildGeoAuditReport({
      siteName: 'X', start: '2026-05-01', end: '2026-08-01',
      fetched: [{ page: 'https://example.com/broken', result: { ok: false, error: 'timeout' }, topQuery: '', impressions: 10 }],
      llmsReadiness,
    });
    assert.equal(content.pagesAnalyzed, 0);
    assert.equal(content.findings.length, 0);
    assert.ok(summary.includes('GEO audit for X'));
  });
});
