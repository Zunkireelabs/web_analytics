import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { run, meta, MAX_PAGES } from './seo-sxo.js';

const res = (title, url, domain) => ({ title, url, domain, position: 1 });
const productSerp = { ok: true, results: Array.from({ length: 8 }, (_, i) => res(`Buy running shoes ${i}`, `https://shop${i}.example/products/shoe-${i}/`, `shop${i}.example`)) };
const articleSerp = { ok: true, results: Array.from({ length: 8 }, (_, i) => res(`How to choose running shoes ${i}`, `https://blog${i}.example/blog/shoes-${i}/`, `blog${i}.example`)) };
const row = (page, query, avgPosition = 11, impressions = 300) => ({ page, query, avgPosition, impressions });

function mk({ rows = [], serps = {}, types = {}, configured = true } = {}) {
  const calls = { serps: [], classified: [] };
  return {
    calls,
    deps: {
      serpConfigured: () => configured,
      getSiteById: async () => ({ id: 1 }),
      getQueryPageMetrics: async () => rows,
      fetchSerps: async (siteId, queries, opts) => { calls.serps.push({ queries, job: opts.job }); return { byKeyword: new Map(queries.map((q) => [q, serps[q] || { ok: false, reason: 'budget_refused' }])), liveCalls: queries.length, stoppedEarly: null }; },
      classify: async (siteId, page) => { calls.classified.push(page); return types[page] ?? null; },
    },
  };
}
const go = (t, extra = {}) => run({ siteId: 1, start: '2026-11-01', end: '2026-11-20', ...extra, deps: t.deps });

describe('seo-sxo', () => {
  test('an article where Google shows product pages becomes one high-priority report-only finding naming the search, the type and the fix', async () => {
    const t = mk({ rows: [row('https://example.com/blog/best-shoes/', 'buy running shoes')], serps: { 'buy running shoes': productSerp }, types: { 'https://example.com/blog/best-shoes/': { contentType: 'blog' } } });
    const r = await go(t);
    assert.equal(r.status, 'ok');
    const [f] = r.facts.findings;
    assert.equal(f.id, 'seo-sxo:page:https://example.com/blog/best-shoes/');
    assert.equal(f.priority, 'high'); assert.equal(f.recommendedAction, null);
    assert.equal(f.reportOnly.kind, 'sxo-mismatch'); assert.equal(f.reportOnly.page, 'https://example.com/blog/best-shoes/');
    assert.match(f.whyItMatters, /"buy running shoes" brings 300 impressions to \/blog\/best-shoes\/ at position 11\.0/);
    assert.match(f.whyItMatters, /mostly shows product and shop pages.*8 of 8 results.*this page is an article/);
    assert.equal(f.expectedImpact.value, 300);
    assert.equal(f.evidence.serpDominant, 'product'); assert.equal(f.evidence.ourType, 'article'); assert.equal(f.evidence.topResults.length, 3);
    assert.deepEqual(r.facts.checkedPages, ['https://example.com/blog/best-shoes/']);
    assert.deepEqual(t.calls.serps[0], { queries: ['buy running shoes'], job: 'seo-sxo' });
  });

  test('a page whose type fits what Google shows is checked and raises nothing', async () => {
    const t = mk({ rows: [row('https://example.com/blog/guide/', 'how to choose running shoes')], serps: { 'how to choose running shoes': articleSerp }, types: { 'https://example.com/blog/guide/': { contentType: 'blog' } } });
    const r = await go(t);
    assert.deepEqual(r.facts.findings, []); assert.equal(r.narrative, null);
    assert.deepEqual(r.facts.checkedPages, ['https://example.com/blog/guide/']);
  });

  test('pages that could not be judged are skipped, with the reason, and are NOT counted as checked (so an open item stays open)', async () => {
    const t = mk({
      rows: [row('/a', 'q a', 11, 500), row('/b', 'q b', 12, 400), row('/c', 'q c', 13, 300)],
      serps: { 'q a': productSerp, 'q c': productSerp },                 // 'q b' has no results (budget)
      types: { '/a': { contentType: 'legal' }, '/c': { contentType: 'service' } }, // '/a' is a page type we do not judge
    });
    const r = await go(t);
    assert.deepEqual(r.facts.skipped, [{ page: '/a', reason: 'page_type_unknown' }, { page: '/b', reason: 'budget_refused' }]);
    assert.deepEqual(r.facts.checkedPages, ['/c']);
    assert.deepEqual(r.facts.findings.map((f) => f.reportOnly.page), ['/c'], 'only the page that could be judged produced a finding');
  });

  test('a service page against product listings is a medium finding', async () => {
    const t = mk({ rows: [row('/svc', 'buy shoes')], serps: { 'buy shoes': productSerp }, types: { '/svc': { contentType: 'service' } } });
    const r = await go(t);
    assert.equal(r.facts.findings[0].priority, 'medium');
  });

  test('at most MAX_PAGES pages are looked up, the most-seen first; only rows near page one qualify', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(`/p${i}`, `q${i}`, 10, 100 + i * 10)); rows.push(row('/top', 'q top', 3, 9999), row('/deep', 'q deep', 40, 9999));
    const t = mk({ rows });
    await go(t);
    assert.equal(t.calls.serps[0].queries.length, MAX_PAGES);
    assert.deepEqual(t.calls.serps[0].queries, ['q8', 'q7', 'q6', 'q5', 'q4']);
  });

  test('a re-check of one page looks only at that page', async () => {
    const t = mk({ rows: [row('/a', 'q a'), row('/b', 'q b')], serps: { 'q b': productSerp }, types: { '/b': { contentType: 'blog' } } });
    const r = await go(t, { params: { pages: ['/b'] } });
    assert.deepEqual(t.calls.serps[0].queries, ['q b']);
    assert.equal(r.facts.findings.length, 1);
  });

  test('nothing to look up yet, or no search-results source, is said plainly and makes no lookups', async () => {
    const none = mk({ rows: [row('/a', 'q', 4, 900), row('/b', 'q', 30, 900)] });
    const r1 = await go(none);
    assert.equal(r1.status, 'insufficient-data'); assert.match(r1.message, /positions 8 and 20/); assert.equal(none.calls.serps.length, 0);
    const off = mk({ configured: false });
    const r2 = await go(off);
    assert.equal(r2.status, 'insufficient-data'); assert.match(r2.message, /DataForSEO/); assert.equal(off.calls.serps.length, 0);
  });

  test('registered as a weekly, report-only agent', () => {
    assert.equal(meta.id, 'seo-sxo'); assert.deepEqual(meta.requiresCapabilities, ['gsc', 'public-web']);
  });
});
