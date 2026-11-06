import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketSeeds, discoverMarketCompetitors } from './competitor-market-discovery.js';

// What matters here: the paid call is only made with a real market to ask about, one call per market, every refusal
// is reported as a reason rather than as "no competitors", and a candidate whose homepage could not be read can never
// be promoted to a business rival.

const site = { id: 11, gsc_property: 'sc-domain:myclinic.com', country_code: 2524, target_scope: 'local', language_code: 'en' };

function fakeCompetitors(byLocation) {
  const calls = [];
  return {
    calls,
    fetchSerpCompetitors: async (keywords, opts) => {
      calls.push({ keywords, ...opts });
      return byLocation[opts.locationCode] || { ok: true, competitors: [], costUsd: 0.07 };
    },
  };
}
// The REAL shape: analyzePageUrl returns { ok, analysis: {...} }. These fakes used to return the fields flat, which is
// the same wrong shape the code read — so the tests passed while every real page yielded nothing.
const page = (text) => async () => ({ ok: true, analysis: { title: text, metaDescription: '', bodyText: text, wordCount: 50 } });

describe('buildMarketSeeds', () => {
  test('crosses every service with every place and keeps the bare service', () => {
    const seeds = buildMarketSeeds({ services: ['teeth whitening'], locationNames: ['Nepal', 'India'] });
    assert.deepEqual(seeds, ['teeth whitening', 'teeth whitening nepal', 'teeth whitening india']);
  });

  test('drops the prose article from a location name', () => {
    const seeds = buildMarketSeeds({ services: ['seo audit'], locationNames: ['the United States'] });
    assert.deepEqual(seeds, ['seo audit', 'seo audit united states']);
  });

  test('de-duplicates, lowercases and ignores junk services', () => {
    const seeds = buildMarketSeeds({ services: ['  SEO  Audit ', 'seo audit', 'a', ''], locationNames: [] });
    assert.deepEqual(seeds, ['seo audit']);
  });

  test('is capped', () => {
    const seeds = buildMarketSeeds({ services: Array.from({ length: 40 }, (_, i) => `service ${i}`), locationNames: ['Nepal', 'India'], max: 10 });
    assert.equal(seeds.length, 10);
  });

  test('no services means no seeds, so nothing can be asked', () => {
    assert.deepEqual(buildMarketSeeds({ services: [], locationNames: ['Nepal'] }), []);
  });
});

describe('discoverMarketCompetitors', () => {
  test('without known services it makes no paid call and says why', async () => {
    const deps = fakeCompetitors({});
    const out = await discoverMarketCompetitors(site, { services: [], deps });
    assert.equal(out.ok, false);
    assert.equal(out.skipped, 'no_services_known');
    assert.equal(deps.calls.length, 0);
  });

  test('asks once per market and sums the real reported cost', async () => {
    const multi = { ...site, target_scope: 'hybrid' };
    const deps = fakeCompetitors({
      2524: { ok: true, competitors: [{ domain: 'a.com', keywordsRanked: 5, keywordsAsked: 10, presenceShare: 0.5 }], costUsd: 0.07 },
      2840: { ok: true, competitors: [{ domain: 'b.com', keywordsRanked: 4, keywordsAsked: 10, presenceShare: 0.4 }], costUsd: 0.05 },
    });
    deps.analyzePageUrl = page('teeth whitening implants clinic');
    const out = await discoverMarketCompetitors(multi, { services: ['teeth whitening'], deps });
    assert.equal(deps.calls.length, 2);
    assert.ok(Math.abs(out.costUsd - 0.12) < 1e-9);
    assert.equal(out.perLocation.length, 2);
  });

  test('the site itself is never returned as its own competitor', async () => {
    const deps = fakeCompetitors({ 2524: { ok: true, competitors: [{ domain: 'myclinic.com', keywordsRanked: 9, keywordsAsked: 10, presenceShare: 0.9 }], costUsd: 0.07 } });
    const out = await discoverMarketCompetitors(site, { services: ['teeth whitening'], deps });
    assert.deepEqual(out.candidates, []);
  });

  test('noise below the presence floor is dropped', async () => {
    const deps = fakeCompetitors({ 2524: { ok: true, competitors: [{ domain: 'noise.com', keywordsRanked: 1, keywordsAsked: 100, presenceShare: 0.01 }], costUsd: 0.07 } });
    const out = await discoverMarketCompetitors(site, { services: ['teeth whitening'], deps });
    assert.deepEqual(out.candidates, []);
  });

  test('a budget refusal is reported as a reason, not as an empty market', async () => {
    const deps = fakeCompetitors({ 2524: { ok: false, reason: 'budget_refused', competitors: [] } });
    const out = await discoverMarketCompetitors(site, { services: ['teeth whitening'], deps });
    assert.equal(out.ok, false);
    assert.equal(out.skipped, 'budget_refused');
  });

  test('a provider outage is reported as a reason', async () => {
    const deps = fakeCompetitors({ 2524: { ok: false, reason: 'failed', error: 'HTTP 500', competitors: [] } });
    const out = await discoverMarketCompetitors(site, { services: ['teeth whitening'], deps });
    assert.equal(out.skipped, 'provider_unavailable');
  });

  test('a candidate whose homepage covers the same services becomes a business rival', async () => {
    const deps = fakeCompetitors({ 2524: { ok: true, competitors: [{ domain: 'rival.com', keywordsRanked: 8, keywordsAsked: 10, presenceShare: 0.8 }], costUsd: 0.07 } });
    deps.analyzePageUrl = page('teeth whitening and dental implants in pokhara');
    const out = await discoverMarketCompetitors(site, {
      services: ['teeth whitening', 'dental implants'],
      ownTopQueries: ['teeth whitening pokhara', 'dental implants pokhara'],
      deps,
    });
    assert.deepEqual(out.classified.business.map((c) => c.domain), ['rival.com']);
  });

  test('an unreadable homepage keeps the candidate out of business', async () => {
    const deps = fakeCompetitors({ 2524: { ok: true, competitors: [{ domain: 'unknown.com', keywordsRanked: 8, keywordsAsked: 10, presenceShare: 0.8 }], costUsd: 0.07 } });
    deps.analyzePageUrl = async () => ({ ok: false, error: 'timeout' });
    const out = await discoverMarketCompetitors(site, { services: ['teeth whitening'], deps });
    assert.equal(out.classified.business.length, 0);
    assert.equal(out.candidates[0].homepageRead, false);
    assert.equal(out.candidates[0].serviceTermOverlap, null);
  });

  test('a thrown homepage fetch does not abort the run', async () => {
    const deps = fakeCompetitors({ 2524: { ok: true, competitors: [{ domain: 'boom.com', keywordsRanked: 5, keywordsAsked: 10, presenceShare: 0.5 }], costUsd: 0.07 } });
    deps.analyzePageUrl = async () => { throw new Error('socket hang up'); };
    const out = await discoverMarketCompetitors(site, { services: ['teeth whitening'], deps });
    assert.equal(out.ok, true);
    assert.equal(out.candidates.length, 1);
  });

  test('a domain found in two markets is kept once, with both markets recorded', async () => {
    const multi = { ...site, target_scope: 'hybrid' };
    const both = { ok: true, competitors: [{ domain: 'rival.com', keywordsRanked: 5, keywordsAsked: 10, presenceShare: 0.5 }], costUsd: 0.07 };
    const deps = fakeCompetitors({ 2524: both, 2840: both });
    deps.analyzePageUrl = page('teeth whitening');
    const out = await discoverMarketCompetitors(multi, { services: ['teeth whitening'], deps });
    assert.equal(out.candidates.length, 1);
    assert.deepEqual(out.candidates[0].locationCodes.sort(), [2524, 2840]);
  });

  test("another company's homepage text is never returned", async () => {
    const deps = fakeCompetitors({ 2524: { ok: true, competitors: [{ domain: 'rival.com', keywordsRanked: 8, keywordsAsked: 10, presenceShare: 0.8 }], costUsd: 0.07 } });
    deps.analyzePageUrl = page('secret competitor homepage copy');
    const out = await discoverMarketCompetitors(site, { services: ['teeth whitening'], deps });
    assert.ok(!JSON.stringify(out).includes('secret competitor homepage copy'));
  });

  test('every paid call is tagged with this project', async () => {
    const deps = fakeCompetitors({ 2524: { ok: true, competitors: [], costUsd: 0 } });
    await discoverMarketCompetitors(site, { services: ['teeth whitening'], deps });
    assert.equal(deps.calls[0].siteId, 11);
  });
});
