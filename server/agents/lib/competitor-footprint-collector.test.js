import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectCompetitorFootprints } from './competitor-footprint-collector.js';

// This is the first part of the system that spends money per run, so the guards are the behaviour under test: no
// vocabulary means no call, fresh competitors are not re-bought, a budget refusal stops the whole run, and an
// incomplete collection is recorded as 'partial' so the next run retries it.

const site = { id: 5, country_code: 2524, target_scope: 'local', language_code: 'en' };

function harness({ due = [{ domain: 'rival.com', relevance_score: 0.8 }], keywords = {}, pages = {}, terms = ['teeth whitening'] } = {}) {
  const calls = { keywords: [], pages: [], saved: [], runs: [] };
  return {
    calls,
    deps: {
      resolveMarketServiceTerms: async () => ({ terms, source: 'verified-capabilities', confidence: 'high' }),
      listCompetitorsNeedingFootprint: async () => due,
      fetchRankedKeywords: async (domain, opts) => {
        calls.keywords.push({ domain, ...opts });
        return keywords[domain] || { ok: true, keywords: [{ keyword: 'teeth whitening cost', locationCode: opts.locationCode, position: 3, searchVolume: 400 }], costUsd: 0.05 };
      },
      fetchRelevantPages: async (domain, opts) => {
        calls.pages.push({ domain, ...opts });
        return pages[domain] || { ok: true, pages: [{ url: `https://${domain}/whitening`, estimatedTraffic: 120 }], costUsd: 0.02 };
      },
      saveCompetitorKeywords: async (siteId, domain, rows) => { calls.saved.push({ siteId, domain, count: rows.length }); return rows.length; },
      saveCompetitorPages: async (siteId, domain, rows) => rows.length,
      recordFootprintRun: async (siteId, domain, row) => { calls.runs.push({ siteId, domain, ...row }); return row; },
    },
  };
}

describe('collectCompetitorFootprints', () => {
  test('without the client\'s own vocabulary it makes no paid call', async () => {
    const h = harness({ terms: [] });
    const out = await collectCompetitorFootprints(site, { deps: h.deps });
    assert.equal(out.ok, false);
    assert.equal(out.skipped[0].reason, 'no_services_known');
    assert.equal(h.calls.keywords.length, 0);
  });

  test('nothing due means nothing bought, with a reason', async () => {
    const h = harness({ due: [] });
    const out = await collectCompetitorFootprints(site, { deps: h.deps });
    assert.equal(out.ok, true);
    assert.equal(h.calls.keywords.length, 0);
    assert.equal(out.skipped[0].reason, 'all_fresh_or_no_business_competitors');
  });

  test('collects a due competitor, stores keywords and pages, and sums the real cost', async () => {
    const h = harness();
    const out = await collectCompetitorFootprints(site, { deps: h.deps });
    assert.deepEqual(out.collected.map((c) => [c.domain, c.keywordsStored, c.status]), [['rival.com', 1, 'ok']]);
    assert.ok(Math.abs(out.costUsd - 0.07) < 1e-9);
    assert.equal(h.calls.runs[0].status, 'ok');
  });

  test('the client\'s service terms are passed to the provider as the relevance filter', async () => {
    const h = harness({ terms: ['teeth whitening', 'implants'] });
    await collectCompetitorFootprints(site, { deps: h.deps });
    assert.deepEqual(h.calls.keywords[0].filterTerms, ['teeth whitening', 'implants']);
  });

  test('every paid call is tagged with this project', async () => {
    const h = harness();
    await collectCompetitorFootprints(site, { deps: h.deps });
    assert.equal(h.calls.keywords[0].siteId, 5);
    assert.equal(h.calls.pages[0].siteId, 5);
  });

  test('a budget refusal stops the run and every remaining competitor is reported as skipped', async () => {
    const h = harness({
      due: [{ domain: 'a.com' }, { domain: 'b.com' }, { domain: 'c.com' }],
      keywords: { 'a.com': { ok: false, reason: 'budget_refused', keywords: [] } },
    });
    const out = await collectCompetitorFootprints(site, { deps: h.deps });
    assert.equal(out.stoppedEarly, 'budget_refused');
    assert.deepEqual(out.skipped.map((s) => s.domain), ['a.com', 'b.com', 'c.com']);
    assert.deepEqual(h.calls.keywords.map((c) => c.domain), ['a.com']);
  });

  test('one competitor failing does not stop the others', async () => {
    const h = harness({
      due: [{ domain: 'broken.com' }, { domain: 'fine.com' }],
      keywords: { 'broken.com': { ok: false, reason: 'failed', error: 'HTTP 500', keywords: [] } },
    });
    const out = await collectCompetitorFootprints(site, { deps: h.deps });
    assert.deepEqual(out.collected.map((c) => c.domain), ['fine.com']);
    assert.deepEqual(out.skipped.map((s) => s.domain), ['broken.com']);
    assert.equal(h.calls.runs.find((r) => r.domain === 'broken.com').status, 'failed');
  });

  test('a run that stored keywords but hit a page failure is partial, so the next run retries it', async () => {
    const h = harness({ pages: { 'rival.com': { ok: false, reason: 'failed', error: 'HTTP 502', pages: [] } } });
    const out = await collectCompetitorFootprints(site, { deps: h.deps });
    assert.equal(out.collected[0].status, 'partial');
    assert.match(h.calls.runs[0].detail, /pages/);
  });

  test('pages are not bought for a competitor whose keywords returned nothing', async () => {
    const h = harness({ keywords: { 'rival.com': { ok: true, keywords: [], costUsd: 0.05 } } });
    const out = await collectCompetitorFootprints(site, { deps: h.deps });
    assert.equal(h.calls.pages.length, 0);
    assert.equal(out.skipped[0].reason, 'failed');
  });

  test('--no-pages collects keywords only', async () => {
    const h = harness();
    await collectCompetitorFootprints(site, { includePages: false, deps: h.deps });
    assert.equal(h.calls.pages.length, 0);
    assert.equal(h.calls.keywords.length, 1);
  });

  test('the per-run competitor cap is passed to the due query, not applied afterwards', async () => {
    let askedLimit = null;
    const h = harness();
    h.deps.listCompetitorsNeedingFootprint = async (_siteId, opts) => { askedLimit = opts.limit; return []; };
    await collectCompetitorFootprints(site, { maxCompetitors: 2, deps: h.deps });
    assert.equal(askedLimit, 2);
  });

  test('the freshness window is passed to the due query', async () => {
    let askedAge = null;
    const h = harness();
    h.deps.listCompetitorsNeedingFootprint = async (_siteId, opts) => { askedAge = opts.maxAgeDays; return []; };
    await collectCompetitorFootprints(site, { freshnessDays: 7, deps: h.deps });
    assert.equal(askedAge, 7);
  });

  test('a multi-market site is collected in each market, under one snapshot timestamp per competitor', async () => {
    const h = harness();
    const out = await collectCompetitorFootprints({ ...site, target_scope: 'hybrid' }, { deps: h.deps });
    assert.deepEqual(h.calls.keywords.map((c) => c.locationCode), [2524, 2840]);
    assert.equal(out.collected[0].keywordsStored, 2);
  });
});
