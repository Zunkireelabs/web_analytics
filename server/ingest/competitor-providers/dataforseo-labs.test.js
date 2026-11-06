import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSerpCompetitors, fetchRankedKeywords, fetchRelevantPages, configured } from './dataforseo-labs.js';

const ok = (items, costUsd = 0.07) => ({ ok: true, costUsd, body: { tasks: [{ result: [{ items }] }] } });
function spy(result) {
  const calls = [];
  return { calls, dataforseoCall: async (args) => { calls.push(args); return result; } };
}

describe('fetchSerpCompetitors', () => {
  test('maps competitors and orders them by how many keywords they rank for', async () => {
    const deps = spy(ok([
      { domain: 'small.com', metrics: { organic: { count: 2, etv: 10 } } },
      { domain: 'https://www.Big.com/path', metrics: { organic: { count: 8, etv: 900 } } },
    ]));
    const out = await fetchSerpCompetitors(['a', 'b'], { siteId: 1, locationCode: 2524, languageCode: 'en', deps });
    assert.equal(out.ok, true);
    assert.deepEqual(out.competitors.map((c) => c.domain), ['big.com', 'small.com']);
    assert.equal(out.competitors[0].keywordsRanked, 8);
  });

  test('presence share is the share of asked keywords, capped at 1', async () => {
    const deps = spy(ok([{ domain: 'a.com', metrics: { organic: { count: 5 } } }, { domain: 'b.com', metrics: { organic: { count: 99 } } }]));
    const out = await fetchSerpCompetitors(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10'], { siteId: 1, deps });
    assert.equal(out.competitors.find((c) => c.domain === 'a.com').presenceShare, 0.5);
    assert.equal(out.competitors.find((c) => c.domain === 'b.com').presenceShare, 1);
  });

  test('a metric the provider did not return stays null, not zero', async () => {
    const deps = spy(ok([{ domain: 'a.com', metrics: { organic: { count: 3 } } }]));
    const out = await fetchSerpCompetitors(['x'], { siteId: 1, deps });
    assert.equal(out.competitors[0].estimatedTrafficVolume, null);
    assert.equal(out.competitors[0].visibility, null);
  });

  test('keywords are de-duplicated, trimmed, lowercased and capped', async () => {
    const deps = spy(ok([]));
    await fetchSerpCompetitors([' Teeth Whitening ', 'teeth whitening', 'implants', ''], { siteId: 1, deps });
    assert.deepEqual(deps.calls[0].body[0].keywords, ['teeth whitening', 'implants']);
    const many = Array.from({ length: 250 }, (_, i) => `kw${i}`);
    await fetchSerpCompetitors(many, { siteId: 1, deps });
    assert.equal(deps.calls[1].body[0].keywords.length, 200);
  });

  test('no keywords makes no paid call', async () => {
    const deps = spy(ok([]));
    const out = await fetchSerpCompetitors([], { siteId: 1, deps });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no_keywords');
    assert.equal(deps.calls.length, 0);
  });

  test('a budget refusal is reported, not thrown', async () => {
    const deps = spy({ ok: false, reason: 'budget_refused', spentUsd: 5, budgetUsd: 5 });
    const out = await fetchSerpCompetitors(['x'], { siteId: 1, deps });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'budget_refused');
    assert.deepEqual(out.competitors, []);
  });

  test('a provider failure is reported, not thrown', async () => {
    const deps = spy({ ok: false, reason: 'failed', error: 'HTTP 500' });
    const out = await fetchSerpCompetitors(['x'], { siteId: 1, deps });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'HTTP 500');
  });

  test('junk domains are dropped rather than passed on', async () => {
    const deps = spy(ok([{ domain: 'not a domain', metrics: { organic: { count: 9 } } }, { domain: 'real.com', metrics: { organic: { count: 1 } } }]));
    const out = await fetchSerpCompetitors(['x'], { siteId: 1, deps });
    assert.deepEqual(out.competitors.map((c) => c.domain), ['real.com']);
  });

  test('an empty result set is a valid answer, not a failure', async () => {
    const out = await fetchSerpCompetitors(['x'], { siteId: 1, deps: spy(ok([])) });
    assert.equal(out.ok, true);
    assert.deepEqual(out.competitors, []);
  });

  test('the call is tagged with the site and job so the ledger can attribute it', async () => {
    const deps = spy(ok([]));
    await fetchSerpCompetitors(['x'], { siteId: 42, deps });
    assert.equal(deps.calls[0].siteId, 42);
    assert.equal(deps.calls[0].job, 'competitor-discovery');
    assert.match(deps.calls[0].endpoint, /serp_competitors/);
  });

  test('a missing siteId is a programming error and throws', async () => {
    await assert.rejects(() => fetchSerpCompetitors(['x'], { deps: spy(ok([])) }), /siteId/);
  });

  test('configured() follows the DataForSEO credentials', () => {
    const saved = { l: process.env.DATAFORSEO_LOGIN, p: process.env.DATAFORSEO_PASSWORD };
    delete process.env.DATAFORSEO_LOGIN; delete process.env.DATAFORSEO_PASSWORD;
    assert.equal(configured(), false);
    process.env.DATAFORSEO_LOGIN = 'u'; process.env.DATAFORSEO_PASSWORD = 'p';
    assert.equal(configured(), true);
    if (saved.l === undefined) delete process.env.DATAFORSEO_LOGIN; else process.env.DATAFORSEO_LOGIN = saved.l;
    if (saved.p === undefined) delete process.env.DATAFORSEO_PASSWORD; else process.env.DATAFORSEO_PASSWORD = saved.p;
  });
});

const rankedItem = (keyword, over = {}) => ({
  keyword_data: {
    keyword,
    // 'volume' in over is honoured even when it is null, so a test can model a metric the provider did not return.
    keyword_info: { search_volume: 'volume' in over ? over.volume : 300, cpc: over.cpc ?? 2.5 },
    keyword_properties: { keyword_difficulty: over.kd ?? 40 },
    search_intent_info: { main_intent: over.intent ?? 'commercial' },
  },
  ranked_serp_element: { serp_item: { rank_absolute: over.position ?? 4, url: over.url ?? `https://rival.com/${keyword.replace(/\s+/g, '-')}`, etv: over.etv ?? 20 } },
});

describe('fetchRankedKeywords', () => {
  test('maps every metric the provider returned', async () => {
    const deps = spy(ok([rankedItem('teeth whitening cost')]));
    const out = await fetchRankedKeywords('rival.com', { siteId: 1, locationCode: 2524, languageCode: 'en', filterTerms: ['teeth whitening'], deps });
    assert.equal(out.ok, true);
    assert.deepEqual(out.keywords[0], {
      keyword: 'teeth whitening cost', position: 4, rankingUrl: 'https://rival.com/teeth-whitening-cost',
      searchVolume: 300, keywordDifficulty: 40, cpc: 2.5, searchIntent: 'commercial', estimatedTraffic: 20,
      locationCode: 2524, languageCode: 'en',
    });
  });

  test('keeps only keywords sharing a real word with what the client sells', async () => {
    const deps = spy(ok([rankedItem('teeth whitening cost'), rankedItem('used car finance'), rankedItem('dental implants price')]));
    const out = await fetchRankedKeywords('rival.com', { siteId: 1, filterTerms: ['teeth whitening', 'dental implants'], deps });
    assert.deepEqual(out.keywords.map((k) => k.keyword), ['teeth whitening cost', 'dental implants price']);
    assert.equal(out.returned, 3);
    assert.equal(out.kept, 2);
  });

  test('no filter terms means no filtering, so the collector must always pass them', async () => {
    const deps = spy(ok([rankedItem('completely unrelated thing')]));
    const out = await fetchRankedKeywords('rival.com', { siteId: 1, deps });
    assert.equal(out.keywords.length, 1);
  });

  test('keywords below the demand floor are dropped, but unmeasured demand is kept', async () => {
    const deps = spy(ok([rankedItem('whitening tiny', { volume: 2 }), rankedItem('whitening unknown', { volume: null })]));
    const out = await fetchRankedKeywords('rival.com', { siteId: 1, minVolume: 10, filterTerms: ['whitening'], deps });
    assert.deepEqual(out.keywords.map((k) => k.keyword), ['whitening unknown']);
    assert.equal(out.keywords[0].searchVolume, null);
  });

  test('an unknown intent is stored as null rather than passed through', async () => {
    const deps = spy(ok([rankedItem('whitening x', { intent: 'shopping' })]));
    const out = await fetchRankedKeywords('rival.com', { siteId: 1, filterTerms: ['whitening'], deps });
    assert.equal(out.keywords[0].searchIntent, null);
  });

  test('results are highest-demand first', async () => {
    const deps = spy(ok([rankedItem('whitening small', { volume: 50 }), rankedItem('whitening big', { volume: 5000 })]));
    const out = await fetchRankedKeywords('rival.com', { siteId: 1, filterTerms: ['whitening'], deps });
    assert.deepEqual(out.keywords.map((k) => k.keyword), ['whitening big', 'whitening small']);
  });

  test('the request asks the provider to narrow by rank, and is tagged for the ledger', async () => {
    const deps = spy(ok([]));
    await fetchRankedKeywords('https://www.Rival.com/path', { siteId: 7, maxPosition: 20, deps });
    assert.equal(deps.calls[0].body[0].target, 'rival.com');
    assert.equal(deps.calls[0].siteId, 7);
    assert.equal(deps.calls[0].job, 'competitor-footprint');
    assert.deepEqual(deps.calls[0].body[0].filters, [['ranked_serp_element.serp_item.rank_group', '<=', 20]]);
  });

  test('a budget refusal and a junk domain are both reported, not thrown', async () => {
    const refused = await fetchRankedKeywords('rival.com', { siteId: 1, deps: spy({ ok: false, reason: 'budget_refused', spentUsd: 5, budgetUsd: 5 }) });
    assert.equal(refused.reason, 'budget_refused');
    const junk = await fetchRankedKeywords('not a domain', { siteId: 1, deps: spy(ok([])) });
    assert.equal(junk.reason, 'invalid_domain');
  });

  test('a missing siteId throws', async () => {
    await assert.rejects(() => fetchRankedKeywords('rival.com', { deps: spy(ok([])) }), /siteId/);
  });
});

describe('fetchRelevantPages', () => {
  test('maps pages and orders them by estimated traffic', async () => {
    const deps = spy(ok([
      { page_address: 'https://rival.com/small', metrics: { organic: { etv: 10, count: 3 } } },
      { page_address: 'https://rival.com/big', metrics: { organic: { etv: 900, count: 40 } } },
    ]));
    const out = await fetchRelevantPages('rival.com', { siteId: 1, deps });
    assert.deepEqual(out.pages.map((p) => p.url), ['https://rival.com/big', 'https://rival.com/small']);
    assert.equal(out.pages[0].keywordCount, 40);
  });

  test('a page with no traffic metric keeps null rather than zero', async () => {
    const deps = spy(ok([{ page_address: 'https://rival.com/a' }]));
    const out = await fetchRelevantPages('rival.com', { siteId: 1, deps });
    assert.equal(out.pages[0].estimatedTraffic, null);
    assert.equal(out.pages[0].keywordCount, null);
  });

  test('rows without a URL are dropped, and failures are reported', async () => {
    const deps = spy(ok([{ metrics: { organic: { etv: 5 } } }]));
    assert.deepEqual((await fetchRelevantPages('rival.com', { siteId: 1, deps })).pages, []);
    const failed = await fetchRelevantPages('rival.com', { siteId: 1, deps: spy({ ok: false, reason: 'failed', error: 'HTTP 500' }) });
    assert.equal(failed.ok, false);
  });
});
