import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planSerpMerges, serpMergeEnabled, serpMergeLimit, MAX_KEYWORDS } from './keyword-serp-merge.js';

// Result pages: keywords in one "family" share most of their ten pages; different families share none.
const pages = (family, n = 10, own = '') => Array.from({ length: n }, (_, i) => ({ url: `https://${family}${i}.example/${own}` }));
const serp = (family, sharedCount, ownTag) => ({ ok: true, results: [...pages(family, sharedCount), ...pages(`${ownTag}-own`, 10 - sharedCount)] });
const gap = (id, topic, extra = {}) => ({ id, topic, search_volume: 100, source: 'internal_analysis', ...extra });
const CHOSEN = new Set(['user_request', 'trend_radar']);
const lookupOf = (map) => async (siteId, topics) => ({ byKeyword: new Map(topics.map((t) => [t, map[t] || { ok: false, reason: 'not_configured' }])), liveCalls: topics.length, stoppedEarly: null });

describe('planSerpMerges', () => {
  test('keywords that share 7+ results fold into the biggest one; a different search is left alone', async () => {
    const r = await planSerpMerges({
      siteId: 1, chosenSources: CHOSEN,
      keywords: [gap(1, 'best crm software', { search_volume: 5000 }), gap(2, 'top crm software', { search_volume: 900 }), gap(3, 'crm for plumbers', { search_volume: 300 })],
      lookup: lookupOf({ 'best crm software': serp('crm', 8, 'a'), 'top crm software': serp('crm', 8, 'b'), 'crm for plumbers': serp('plumb', 10, 'c') }),
    });
    assert.deepEqual(r.merges.map((m) => [m.keywordId, m.intoId, m.shared]), [[2, 1, 8]]);
    assert.match(r.merges[0].note, /Merged into "best crm software": Google shows almost the same results for both \(8 of 10 pages are the same\)/);
    assert.equal(r.looked, 3);
  });

  test('a keyword a person typed in is never folded away: the others fold into it, even if it is smaller', async () => {
    const r = await planSerpMerges({
      siteId: 1, chosenSources: CHOSEN,
      keywords: [gap(1, 'big keyword', { search_volume: 9000 }), gap(2, 'my keyword', { search_volume: 10, source: 'user_request' })],
      lookup: lookupOf({ 'big keyword': serp('f', 9, 'a'), 'my keyword': serp('f', 9, 'b') }),
    });
    assert.deepEqual(r.merges.map((m) => [m.keywordId, m.intoId]), [[1, 2]]);
  });

  test('two person-chosen keywords are never folded into each other', async () => {
    const r = await planSerpMerges({
      siteId: 1, chosenSources: CHOSEN,
      keywords: [gap(1, 'one', { source: 'user_request' }), gap(2, 'two', { source: 'trend_radar' }), gap(3, 'three')],
      lookup: lookupOf({ one: serp('f', 9, 'a'), two: serp('f', 9, 'b'), three: serp('f', 9, 'c') }),
    });
    assert.deepEqual(r.merges.map((m) => m.keywordId), [3], 'only the ordinary keyword folds');
  });

  test('a keyword with no result (not configured, budget refused) is never judged, so never dropped', async () => {
    const r = await planSerpMerges({
      siteId: 1, chosenSources: CHOSEN,
      keywords: [gap(1, 'looked up'), gap(2, 'no data'), gap(3, 'also looked up')],
      lookup: lookupOf({ 'looked up': serp('f', 9, 'a'), 'also looked up': serp('f', 9, 'b') }),
    });
    assert.deepEqual(r.merges.map((m) => m.keywordId), [3]);
    assert.ok(!r.merges.some((m) => m.keywordId === 2));
  });

  test('merging is transitive within one page group and each folded keyword points at the kept one', async () => {
    const same = serp('f', 10, 'x');
    const r = await planSerpMerges({
      siteId: 1, chosenSources: CHOSEN,
      keywords: [gap(1, 'a', { search_volume: 10 }), gap(2, 'b', { search_volume: 50 }), gap(3, 'c', { search_volume: 30 })],
      lookup: lookupOf({ a: same, b: same, c: same }),
    });
    assert.deepEqual(r.merges.map((m) => [m.keywordId, m.intoId]), [[1, 2], [3, 2]]);
  });

  test('no keywords, one keyword, or nothing looked up: no merges and no lookup when there is nothing to compare', async () => {
    let called = 0; const lookup = async () => { called += 1; return { byKeyword: new Map(), liveCalls: 0, stoppedEarly: null }; };
    assert.deepEqual((await planSerpMerges({ siteId: 1, keywords: [], lookup })).merges, []);
    assert.deepEqual((await planSerpMerges({ siteId: 1, keywords: [gap(1, 'only')], lookup })).merges, []);
    assert.equal(called, 0);
    assert.deepEqual((await planSerpMerges({ siteId: 1, keywords: [gap(1, 'a'), gap(2, 'b')], lookup })).merges, []);
  });

  test('at most the cap are looked up; the rest are not touched', async () => {
    let asked;
    const lookup = async (siteId, topics) => { asked = topics; return { byKeyword: new Map(), liveCalls: 0, stoppedEarly: null }; };
    await planSerpMerges({ siteId: 1, keywords: Array.from({ length: 30 }, (_, i) => gap(i + 1, `kw ${i}`)), lookup, maxKeywords: 5 });
    assert.equal(asked.length, 5);
    assert.deepEqual(asked, ['kw 0', 'kw 1', 'kw 2', 'kw 3', 'kw 4']);
  });

  test('reports a budget stop so a short run is never mistaken for a complete one', async () => {
    const lookup = async (s, topics) => ({ byKeyword: new Map(topics.map((t) => [t, { ok: false, reason: 'budget_refused' }])), liveCalls: 0, stoppedEarly: 'budget_refused' });
    const r = await planSerpMerges({ siteId: 1, keywords: [gap(1, 'a'), gap(2, 'b')], lookup });
    assert.equal(r.stoppedEarly, 'budget_refused'); assert.deepEqual(r.merges, []);
  });
});

describe('results from SerpApi, whose redirect links change on every search', () => {
  // The same eight pages in both searches, but each carries a different (useless) redirect URL; only matchKey identifies the page.
  const redirected = (tag, n = 8) => ({ ok: true, results: Array.from({ length: n }, (_, i) => ({ url: `https://www.google.com/goto?url=${tag}-${i}`, matchKey: `https://site${i}.example/page-${i}`, domain: `site${i}.example` })) });
  test('the same pages are recognised through their match key, so the two keywords fold', async () => {
    const r = await planSerpMerges({
      siteId: 1, chosenSources: CHOSEN,
      keywords: [gap(1, 'best crm', { search_volume: 900 }), gap(2, 'top crm', { search_volume: 100 })],
      lookup: lookupOf({ 'best crm': redirected('A'), 'top crm': redirected('B') }),
    });
    assert.deepEqual(r.merges.map((m) => [m.keywordId, m.intoId, m.shared]), [[2, 1, 8]]);
  });
  test('without a match key the redirect URLs would never match, which is exactly why it is used', async () => {
    const strip = (x) => ({ ...x, results: x.results.map(({ matchKey, ...rest }) => rest) });
    const r = await planSerpMerges({ siteId: 1, chosenSources: CHOSEN, keywords: [gap(1, 'best crm'), gap(2, 'top crm')], lookup: lookupOf({ 'best crm': strip(redirected('A')), 'top crm': strip(redirected('B')) }) });
    assert.deepEqual(r.merges, []);
  });
});

describe('controls', () => {
  test('on by default; KEYWORD_SERP_MERGE=off|false|0|no switches it off', () => {
    assert.equal(serpMergeEnabled({}), true);
    for (const v of ['off', 'OFF', 'false', '0', 'no', ' off ']) assert.equal(serpMergeEnabled({ KEYWORD_SERP_MERGE: v }), false, v);
    assert.equal(serpMergeEnabled({ KEYWORD_SERP_MERGE: 'on' }), true);
  });
  test('the cap defaults to 20, is configurable, and stays between 2 and 50', () => {
    assert.equal(serpMergeLimit({}), MAX_KEYWORDS);
    assert.equal(serpMergeLimit({ KEYWORD_SERP_MAX: '8' }), 8);
    assert.equal(serpMergeLimit({ KEYWORD_SERP_MAX: '1000' }), 50);
    assert.equal(serpMergeLimit({ KEYWORD_SERP_MAX: '0' }), 20);
    assert.equal(serpMergeLimit({ KEYWORD_SERP_MAX: 'x' }), 20);
  });
});
