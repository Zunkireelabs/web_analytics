import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runCompetitorGrowthCycle } from './competitor-growth-cycle.js';

// What this cycle must guarantee: it never buys what is still fresh, a dry run never spends money, each stage reports
// its own reason for not running, and it stops at the queue — no draft, no PR, no second decision path.

const site = { id: 3, country_code: 2524, target_scope: 'local', language_code: 'en' };
const footprintRow = {
  competitor_domain: 'rival.com', keyword: 'teeth whitening cost', location_code: 2524, language_code: 'en',
  position: 3, ranking_url: 'https://rival.com/whitening', search_volume: 400, keyword_difficulty: 30,
  search_intent: 'commercial', captured_at: new Date(),
};

function harness(over = {}) {
  const calls = { discovery: 0, footprint: 0, saved: [], classified: [] };
  const deps = {
    resolveMarketServiceTerms: async () => ({ terms: ['teeth whitening'], source: 'verified-capabilities' }),
    listCompetitorsByKind: async () => over.known ?? [],
    discoverMarketCompetitors: async () => {
      calls.discovery += 1;
      return over.discovery ?? {
        ok: true, costUsd: 0.07,
        classified: {
          business: [{ domain: 'rival.com', kind: 'business', relevanceScore: 0.8, evidence: {}, reason: 'r', confidence: 'high' }],
          overflowBusiness: [], organic: [], keywordSpecific: [], excluded: [],
        },
      };
    },
    collectCompetitorFootprints: async () => {
      calls.footprint += 1;
      return over.footprint ?? { ok: true, collected: [{ domain: 'rival.com', keywordsStored: 1, status: 'ok' }], skipped: [], costUsd: 0.05, stoppedEarly: null };
    },
    upsertCompetitorClassification: async (siteId, domain, row) => { calls.classified.push({ domain, ...row }); },
    getAllLatestFootprints: async () => over.footprintRows ?? [footprintRow],
    getQueryPageMetrics: async () => over.queryPages ?? [],
    getKeywordGaps: async () => over.existingGaps ?? [],
    getLearnedMultipliers: async () => over.learned ?? {},
    saveCompetitorOpportunities: async (siteId, rows) => { calls.saved.push({ siteId, rows }); return { inserted: rows.length, updated: 0 }; },
  };
  return { calls, deps };
}

describe('runCompetitorGrowthCycle', () => {
  test('a project with no described services does nothing, and every stage says why', async () => {
    const h = harness();
    h.deps.resolveMarketServiceTerms = async () => ({ terms: [], source: null });
    const report = await runCompetitorGrowthCycle(site, { deps: h.deps });
    assert.equal(report.discovery.reason, 'no_services_known');
    assert.equal(report.footprint.reason, 'no_services_known');
    assert.equal(report.opportunities.reason, 'no_services_known');
    assert.equal(h.calls.discovery, 0);
    assert.equal(report.costUsd, 0);
  });

  test('the full path: discover, collect, build and write opportunities, summing real cost', async () => {
    const h = harness();
    const report = await runCompetitorGrowthCycle(site, { deps: h.deps });
    assert.equal(report.discovery.ok, true);
    assert.deepEqual(report.discovery.business, ['rival.com']);
    assert.equal(report.footprint.ran, true);
    assert.equal(report.opportunities.built, 1);
    assert.equal(report.opportunities.written.inserted, 1);
    assert.ok(Math.abs(report.costUsd - 0.12) < 1e-9);
  });

  test('discovery is skipped while the known market is fresh', async () => {
    const h = harness({ known: [{ domain: 'rival.com', last_analyzed_at: new Date() }] });
    const report = await runCompetitorGrowthCycle(site, { deps: h.deps });
    assert.equal(h.calls.discovery, 0);
    assert.equal(report.discovery.reason, 'fresh');
    assert.equal(report.discovery.businessCompetitors, 1);
  });

  test('a stale market is rediscovered', async () => {
    const h = harness({ known: [{ domain: 'rival.com', last_analyzed_at: new Date(Date.now() - 40 * 86400000) }] });
    await runCompetitorGrowthCycle(site, { deps: h.deps });
    assert.equal(h.calls.discovery, 1);
  });

  test('a dry run never buys a footprint and never writes', async () => {
    const h = harness();
    const report = await runCompetitorGrowthCycle(site, { save: false, deps: h.deps });
    assert.equal(h.calls.footprint, 0);
    assert.equal(report.footprint.reason, 'dry_run');
    assert.equal(h.calls.saved.length, 0);
    assert.equal(h.calls.classified.length, 0);
    assert.ok(report.opportunities.built >= 1, 'a dry run still shows what it would propose');
  });

  test('no footprint yet is reported as a skipped stage, not an empty market', async () => {
    const h = harness({ footprintRows: [] });
    const report = await runCompetitorGrowthCycle(site, { deps: h.deps });
    assert.equal(report.opportunities.ran, false);
    assert.equal(report.opportunities.reason, 'no_footprint_yet');
  });

  test('a discovery failure is reported and does not stop the later stages', async () => {
    const h = harness({ discovery: { ok: false, skipped: 'budget_refused', costUsd: 0 } });
    const report = await runCompetitorGrowthCycle(site, { deps: h.deps });
    assert.equal(report.discovery.ok, false);
    assert.equal(report.discovery.reason, 'budget_refused');
    assert.equal(report.opportunities.ran, true);
  });

  test('our own ranking pages are used, so an already-ranking keyword becomes page work', async () => {
    const h = harness({
      queryPages: [{ query: 'teeth whitening cost', page: 'https://ours.com/whitening', avgPosition: 18, impressions: 200 }],
    });
    const report = await runCompetitorGrowthCycle(site, { deps: h.deps });
    assert.equal(report.opportunities.top[0].type, 'improve_page');
    assert.equal(report.opportunities.top[0].existingPage, 'https://ours.com/whitening');
  });

  test('a topic already in the queue is not proposed again', async () => {
    const h = harness({ existingGaps: [{ topic: 'teeth whitening cost', status: 'pending_review' }] });
    const report = await runCompetitorGrowthCycle(site, { deps: h.deps });
    assert.equal(report.opportunities.built, 0);
    assert.equal(report.opportunities.rejected.already_in_queue, 1);
  });

  test('what the project has learned is applied and reported', async () => {
    const plain = await runCompetitorGrowthCycle(site, { deps: harness().deps });
    const taught = await runCompetitorGrowthCycle(site, { deps: harness({ learned: { missing: 1.3 } }).deps });
    assert.ok(taught.opportunities.top[0].score > plain.opportunities.top[0].score);
    assert.deepEqual(taught.opportunities.learnedMultipliers, { missing: 1.3 });
  });

  test('only the top N are written, however many were built', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...footprintRow, keyword: `whitening variant ${i}` }));
    const h = harness({ footprintRows: many });
    const report = await runCompetitorGrowthCycle(site, { maxOpportunities: 5, deps: h.deps });
    assert.equal(report.opportunities.built, 40);
    assert.equal(report.opportunities.kept, 5);
    assert.equal(h.calls.saved[0].rows.length, 5);
  });

  test('it stops at the queue: no draft, no PR, no recommendation', async () => {
    const h = harness();
    const report = await runCompetitorGrowthCycle(site, { deps: h.deps });
    const text = JSON.stringify(report).toLowerCase();
    for (const forbidden of ['draft', 'pull_request', 'pr_number', 'branch']) {
      assert.ok(!text.includes(forbidden), `cycle must not produce ${forbidden}`);
    }
  });

  test('a database failure in a free read degrades instead of aborting the run', async () => {
    const h = harness();
    h.deps.getQueryPageMetrics = async () => { throw new Error('db down'); };
    h.deps.getKeywordGaps = async () => { throw new Error('db down'); };
    h.deps.getLearnedMultipliers = async () => { throw new Error('db down'); };
    const report = await runCompetitorGrowthCycle(site, { deps: h.deps });
    assert.equal(report.opportunities.ran, true);
  });
});
