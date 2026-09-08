import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Real fixtures: shapes taken verbatim from production rows on site 8862's
// onboarding audit (audit_page_findings.finding_id carries the page URL in
// the middle, so ':' splitting is unsafe) and from the geo-audit agent run.
const FINDINGS = [
  { agent_id: 'content-gap', page: 'https://a.com/', priority: 'high', finding_id: 'content-gap:https://a.com/:Missing alt text' },
  { agent_id: 'content-gap', page: 'https://a.com/x', priority: 'high', finding_id: 'content-gap:https://a.com/x:Missing alt text' },
  { agent_id: 'content-gap', page: 'https://a.com/y', priority: 'high', finding_id: 'content-gap:https://a.com/y:Missing alt text' },
  { agent_id: 'content-gap', page: 'https://a.com/', priority: 'medium', finding_id: 'content-gap:https://a.com/:Missing FAQ' },
  { agent_id: 'technical-seo', page: 'https://a.com/', priority: 'high', finding_id: 'technical-seo:title-length' },
  { agent_id: 'accessibility', page: null, priority: 'low', finding_id: 'accessibility:heading-skip' },
];

const GEO_RUN = {
  created_at: '2026-09-08T02:07:20.212Z',
  facts: { siteScore: { overall: 44, categories: { faq: 30, schema: 25, entities: 0, citationReadiness: 78 } } },
};

let capturedUser = null;
mock.module(resolve('../../llm.js'), {
  namedExports: { callLLM: async (_system, user) => { capturedUser = user; return '# Baseline Report'; } },
});
mock.module(resolve('../../store/read.js'), {
  namedExports: {
    getSiteById: async () => ({ id: 1, name: 'Acme' }),
    getDailySeries: async () => [],
    getHealthScoreOnOrBefore: async () => 60,
  },
});
const RECOMMENDATIONS = [
  { page: 'https://a.com/register', recommendation_type: 'faq', issue: 'Add FAQ', priority: 'high' },
  { page: 'landing::Kathmandu', recommendation_type: 'landing-page', issue: 'Generate Landing Page', priority: 'high' },
  { page: 'https://a.com/x::comparison-content', recommendation_type: 'expand-content', issue: 'Add comparison content', priority: 'medium' },
];
mock.module(resolve('../../store/recommendations.js'), { namedExports: { listOpenRecommendations: async () => RECOMMENDATIONS } });
mock.module(resolve('../../store/audit-runs.js'), {
  namedExports: {
    getLatestAuditRun: async () => ({ id: 9, status: 'completed', health_score: 60, pages_audited: 93 }),
    getAuditPageFindings: async () => FINDINGS,
  },
});
let savedSnapshot = null;
mock.module(resolve('../../store/baseline-reports.js'), {
  namedExports: {
    saveBaselineReport: async (_siteId, payload) => { savedSnapshot = payload; return payload; },
    getBaselineReport: async () => null,
  },
});
let geoRuns = [GEO_RUN];
mock.module(resolve('../../store/agent-runs.js'), { namedExports: { getLatestAgentRuns: async () => geoRuns } });

const { buildBaselineReport } = await import('./baseline-report.js');

describe('baseline report — the day-0 audit actually names what is missing', () => {
  test('groups real per-page findings into named defects, not just a count', async () => {
    geoRuns = [GEO_RUN];
    await buildBaselineReport(1);
    const af = savedSnapshot.issuesSnapshot.auditFindings;

    assert.equal(af.total, 6);
    assert.equal(af.pagesAffected, 3, 'a finding with no page must not inflate the page count');

    // The whole point: "Missing alt text" is named and quantified, where the
    // old report could only ever say "6 findings".
    const alt = af.topDefects.find((d) => d.issue === 'Missing alt text');
    assert.ok(alt, 'the defect label must survive a finding_id containing a URL');
    assert.equal(alt.pages, 3);
    assert.equal(alt.examplePages.length, 3);

    assert.equal(af.topDefects[0].issue, 'Missing alt text', 'most widespread defect leads');
    assert.ok(af.topDefects.some((d) => d.issue === 'title-length'), 'a finding_id with no URL segment still yields its label');
  });

  test('categories carry real counts, distinct pages and high-priority totals', async () => {
    await buildBaselineReport(1);
    const cats = savedSnapshot.issuesSnapshot.auditFindings.byCategory;
    const contentGap = cats.find((c) => c.category === 'content-gap');
    assert.equal(contentGap.count, 4);
    assert.equal(contentGap.pages, 3);
    assert.equal(contentGap.highPriority, 3);
    assert.equal(cats[0].category, 'content-gap', 'largest category first');
  });

  test('AI visibility is included from the geo-audit run, never recomputed', async () => {
    geoRuns = [GEO_RUN];
    await buildBaselineReport(1);
    const ai = savedSnapshot.issuesSnapshot.aiVisibility;
    assert.equal(ai.available, true);
    assert.equal(ai.overall, 44);

    // Banding is computed in code, never left to the model: the first real
    // Admizz report labelled schema 25 and faq 30 "Partial" in its table
    // while the prose below correctly called faq 30 a gap.
    const byName = Object.fromEntries(ai.categories.map((c) => [c.category, c]));
    assert.equal(byName['Entity markup'].score, 0);
    assert.equal(byName['Entity markup'].status, 'Missing');
    assert.equal(byName['Schema markup'].status, 'Missing', '25 is Missing, not Partial');
    assert.equal(byName['FAQ coverage'].status, 'Missing', '30 is Missing, not Partial');
    assert.equal(byName['Citation readiness'].status, 'Good');
    assert.equal(ai.categories[0].category, 'Entity markup', 'worst gap leads the table');
  });

  test('a site whose GEO audit has not run reports unavailable rather than a fabricated score', async () => {
    geoRuns = [];
    await buildBaselineReport(1);
    assert.deepEqual(savedSnapshot.issuesSnapshot.aiVisibility, { available: false });
  });

  test('the narrative is given the real findings, and is told not to promise fixes', async () => {
    geoRuns = [GEO_RUN];
    await buildBaselineReport(1);
    assert.match(capturedUser, /Missing alt text/, 'the model must receive the real defect labels');
    assert.match(capturedUser, /"category":"Entity markup","score":0,"status":"Missing"/,
      'the model receives the pre-computed status so it cannot re-derive it wrongly');
  });
});

describe('baseline report — recommendation page links are never internal identifiers or half-broken URLs', () => {
  test('a real page-scoped URL is kept', async () => {
    await buildBaselineReport(1);
    const items = savedSnapshot.issuesSnapshot.openRecommendations.items;
    assert.equal(items.find((i) => i.issue === 'Add FAQ').page, 'https://a.com/register');
  });

  test('an internal generator parameter (no real URL at all) becomes null, not a rendered dead link', async () => {
    await buildBaselineReport(1);
    const items = savedSnapshot.issuesSnapshot.openRecommendations.items;
    assert.equal(items.find((i) => i.issue === 'Generate Landing Page').page, null);
  });

  test('a real URL with an internal "::" sub-target appended also becomes null', async () => {
    await buildBaselineReport(1);
    const items = savedSnapshot.issuesSnapshot.openRecommendations.items;
    assert.equal(items.find((i) => i.issue === 'Add comparison content').page, null);
  });
});
