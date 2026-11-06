import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runRankCheck, keywordsWorthTracking } from './rank-tracking.js';

// Money is the thing under test here as much as correctness: nothing tracked means no call, a budget refusal stops
// the whole run, an operator keyword (billed 5x) is refused outright, and not ranking is recorded as null rather than
// as a position.

const site = { id: 4, website_domain: 'ourclinic.com', gsc_property: 'sc-domain:ourclinic.com' };
const kw = (keyword, over = {}) => ({ id: over.id ?? 1, keyword, location_code: 2524, language_code: 'en', source: 'user_request', last_checked_at: null, ...over });
const serp = (...domains) => ({
  ok: true, costUsd: 0.002,
  body: { tasks: [{ result: [{ items: domains.map((d, i) => ({ type: 'organic', domain: d, url: `https://${d}/p`, rank_absolute: i + 1 })) }] }] },
});

function harness({ keywords = [kw('teeth whitening cost')], result = serp('rival.com', 'ourclinic.com') } = {}) {
  const calls = { serp: [], saved: [], marked: [] };
  return {
    calls,
    deps: {
      listKeywordsToCheck: async () => keywords,
      dataforseoCall: async (args) => { calls.serp.push(args); return typeof result === 'function' ? result(args) : result; },
      saveCompetitorRankings: async (siteId, rows) => { calls.saved.push({ siteId, rows }); },
      markKeywordsChecked: async (siteId, ids) => { calls.marked.push(...ids); },
    },
  };
}

describe('spending is bounded', () => {
  test('no tracked keyword means no call at all', async () => {
    const h = harness({ keywords: [] });
    const out = await runRankCheck(site, { deps: h.deps });
    assert.equal(h.calls.serp.length, 0);
    assert.equal(out.costUsd, 0);
    assert.equal(out.skipped[0].reason, 'no_tracked_keywords');
  });

  test('a budget refusal stops the run and the rest are reported as skipped', async () => {
    const h = harness({
      keywords: [kw('a', { id: 1 }), kw('b', { id: 2 }), kw('c', { id: 3 })],
      result: { ok: false, reason: 'budget_refused', spentUsd: 1, budgetUsd: 1 },
    });
    const out = await runRankCheck(site, { deps: h.deps });
    assert.equal(out.stoppedEarly, 'budget_refused');
    assert.equal(h.calls.serp.length, 1, 'only the first keyword may be attempted');
    assert.deepEqual(out.skipped.map((s) => s.keyword), ['a', 'b', 'c']);
  });

  test('a search-operator keyword is refused, not paid for at 5x', async () => {
    const h = harness({ keywords: [kw('site:rival.com whitening')] });
    const out = await runRankCheck(site, { deps: h.deps });
    assert.equal(h.calls.serp.length, 0);
    assert.equal(out.skipped[0].reason, 'search_operator_keyword');
  });

  test('one page of results is requested — the cheapest useful depth', async () => {
    const h = harness();
    await runRankCheck(site, { deps: h.deps });
    assert.equal(h.calls.serp[0].body[0].depth, 10);
    assert.equal(h.calls.serp[0].job, 'rank-tracking');
    assert.equal(h.calls.serp[0].siteId, 4);
  });

  test('the real reported cost is summed, never estimated', async () => {
    const h = harness({ keywords: [kw('a', { id: 1 }), kw('b', { id: 2 })] });
    const out = await runRankCheck(site, { deps: h.deps });
    assert.ok(Math.abs(out.costUsd - 0.004) < 1e-9);
  });

  test('the caller\'s limit is passed to the list, so the cap is applied in SQL', async () => {
    let asked = null;
    const h = harness();
    h.deps.listKeywordsToCheck = async (siteId, opts) => { asked = opts.limit; return []; };
    await runRankCheck(site, { limit: 5, deps: h.deps });
    assert.equal(asked, 5);
  });
});

describe('what a check records', () => {
  test('our own position is identified among the results', async () => {
    const h = harness({ result: serp('rival.com', 'other.com', 'ourclinic.com') });
    const out = await runRankCheck(site, { deps: h.deps });
    assert.equal(out.checked[0].position, 3);
    assert.equal(out.checked[0].url, 'https://ourclinic.com/p');
    assert.equal(out.checked[0].topCompetitor, 'rival.com');
  });

  test('not ranking in the top 10 is recorded as null, never as a position', async () => {
    const h = harness({ result: serp('rival.com', 'other.com') });
    const out = await runRankCheck(site, { deps: h.deps });
    assert.equal(out.checked[0].position, null);
    assert.equal(out.checked[0].resultsStored, 2, 'the SERP is still stored, so we know who is there');
  });

  test('a subdomain of ours counts as ours', async () => {
    const h = harness({ result: serp('rival.com', 'clinic.ourclinic.com') });
    const out = await runRankCheck(site, { deps: h.deps });
    assert.equal(out.checked[0].position, 2);
  });

  test('a site identified only by its Search Console property is still recognised', async () => {
    const h = harness({ result: serp('ourclinic.com') });
    const out = await runRankCheck({ id: 4, gsc_property: 'sc-domain:ourclinic.com' }, { deps: h.deps });
    assert.equal(out.checked[0].position, 1);
  });

  test('the whole SERP is stored as a dated snapshot, which is what gives history', async () => {
    const h = harness({ result: serp('rival.com', 'ourclinic.com') });
    await runRankCheck(site, { deps: h.deps });
    const { rows } = h.calls.saved[0];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].query, 'teeth whitening cost');
    assert.match(rows[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(rows.find((r) => r.domain === 'ourclinic.com').isOwnDomain, true);
    assert.equal(rows.find((r) => r.domain === 'rival.com').isOwnDomain, false);
  });

  test('an empty SERP is not a position, and is still marked checked so it is not re-billed first', async () => {
    const h = harness({ result: { ok: true, costUsd: 0.002, body: { tasks: [{ result: [{ items: [] }] }] } } });
    const out = await runRankCheck(site, { deps: h.deps });
    assert.equal(out.checked.length, 0);
    assert.equal(out.skipped[0].reason, 'no_serp_results');
    assert.deepEqual(h.calls.marked, [1]);
  });

  test('only organic results count; ads and other blocks are ignored', async () => {
    const h = harness({
      result: {
        ok: true, costUsd: 0.002,
        body: { tasks: [{ result: [{ items: [
          { type: 'paid', domain: 'ads.com', rank_absolute: 1 },
          { type: 'organic', domain: 'ourclinic.com', url: 'https://ourclinic.com/p', rank_absolute: 1 },
        ] }] }] },
      },
    });
    const out = await runRankCheck(site, { deps: h.deps });
    assert.equal(out.checked[0].position, 1);
    assert.equal(h.calls.saved[0].rows.length, 1);
  });

  test('one keyword failing does not stop the others', async () => {
    const h = harness({
      keywords: [kw('bad', { id: 1 }), kw('good', { id: 2 })],
      result: (args) => (args.body[0].keyword === 'bad'
        ? { ok: false, reason: 'failed', error: 'HTTP 500' }
        : serp('ourclinic.com')),
    });
    const out = await runRankCheck(site, { deps: h.deps });
    assert.deepEqual(out.checked.map((c) => c.keyword), ['good']);
    assert.deepEqual(out.skipped.map((s) => s.keyword), ['bad']);
    assert.deepEqual(h.calls.marked, [2], 'a failed keyword is not marked checked, so it is retried');
  });
});

describe('keywordsWorthTracking', () => {
  const opp = (over = {}) => ({ id: 1, topic: 'teeth whitening cost', location_code: 2524, lifecycle_state: 'merged', ...over });

  test('only work that actually shipped is worth watching', async () => {
    const picked = keywordsWorthTracking([
      opp({ id: 1, lifecycle_state: 'discovered' }),
      opp({ id: 2, lifecycle_state: 'drafted' }),
      opp({ id: 3, lifecycle_state: 'merged' }),
      opp({ id: 4, lifecycle_state: 'deployed' }),
      opp({ id: 5, lifecycle_state: 'verified' }),
    ]);
    assert.deepEqual(picked.map((p) => p.gapId), [3, 4, 5]);
  });

  test('an opportunity with no market cannot be tracked', () => {
    assert.deepEqual(keywordsWorthTracking([opp({ location_code: null })]), []);
  });

  test('empty and junk input is handled', () => {
    assert.deepEqual(keywordsWorthTracking([]), []);
    assert.deepEqual(keywordsWorthTracking(null), []);
    assert.deepEqual(keywordsWorthTracking([null, {}]), []);
  });
});
