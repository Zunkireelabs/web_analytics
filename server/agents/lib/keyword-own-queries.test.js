import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickOwnQueryKeywords, brandTokens, priorityFor, discoverKeywordsFromOwnQueries, MIN_IMPRESSIONS } from './keyword-own-queries.js';

const row = (query, impressions, position, extra = {}) => ({ query, impressions, clicks: 0, position, page: 'https://x.test/p', ...extra });

describe('which of a project\'s own queries become keyword candidates', () => {
  const brand = brandTokens({ name: 'Zennly Marketplace', domain: 'www.zennly.io' });
  test('brand tokens come from the project\'s own name and domain only', () => {
    assert.ok(brand.has('zennly') && brand.has('marketplace'));
    assert.ok(!brand.has('superrank'));
  });
  test('keeps real striking-distance queries, best impressions first, with measured numbers in the reason', () => {
    const out = pickOwnQueryKeywords([row('salon booking software', 120, 12.4, { clicks: 3 }), row('spa scheduling app', 40, 22)], { brand });
    assert.deepEqual(out.map((g) => g.topic), ['salon booking software', 'spa scheduling app']);
    assert.match(out[0].reason, /120 time\(s\).*12\.4.*3 click/);
    assert.equal(out[0].priority, 'high');
    assert.ok(!('search_volume' in out[0]), 'a search-volume figure is never invented');
  });
  test('drops: too few impressions, already top 3, hopeless position, brand searches, one-word, existing topics', () => {
    const out = pickOwnQueryKeywords([
      row('salon software tips', MIN_IMPRESSIONS - 1, 10), row('salon software pricing', 80, 2.1), row('salon software history', 80, 55),
      row('zennly login', 90, 8), row('salons', 90, 8), row('salon rota planner', 90, 9),
    ], { brand, existing: new Set(['salon rota planner']) });
    assert.deepEqual(out, []);
  });
  test('a brand written with a space is still a brand search', () => {
    const b = brandTokens({ name: 'SuperRank', domain: 'superrank.si' });
    assert.deepEqual(pickOwnQueryKeywords([row('super rank', 35, 5), row('superrank ai seo', 50, 8), row('ai citation patterns', 14, 5)], { brand: b }).map((g) => g.topic), ['ai citation patterns']);
  });
  test('word-order duplicates collapse to one search; the cap holds', () => {
    const out = pickOwnQueryKeywords([row('best salon app', 50, 9), row('app salon best', 40, 9), ...Array.from({ length: 30 }, (_, i) => row(`topic ${i} guide`, 20 + i, 10))], { brand, max: 5 });
    assert.equal(out.length, 5);
    assert.equal(out.filter((g) => /salon/.test(g.topic)).length, 1);
  });
  test('priority follows measured visibility', () => {
    assert.equal(priorityFor({ impressions: 150, position: 9 }), 'high');
    assert.equal(priorityFor({ impressions: 150, position: 30 }), 'medium');
    assert.equal(priorityFor({ impressions: 12, position: 30 }), 'low');
  });
});

describe('one project, end to end (injected database)', () => {
  const mk = ({ gsc = [], topics = [] } = {}) => {
    const calls = { queries: [], saved: [], status: [] };
    return {
      calls,
      deps: {
        query: async (sql, params) => { calls.queries.push(params); return { rows: /FROM keyword_gaps/.test(sql) ? topics.map((topic) => ({ topic })) : gsc }; },
        saveKeywordGaps: async (siteId, gaps, source) => calls.saved.push({ siteId, gaps, source }),
        recordDiscoveryStatus: async (siteId, path, s) => calls.status.push({ siteId, path, ...s }),
      },
    };
  };
  const site = { id: 8871, name: 'SuperRank', website_domain: 'superrank.si' };

  test('no Search Console data: nothing saved, and the status says what to check (never silent)', async () => {
    const { calls, deps } = mk();
    const r = await discoverKeywordsFromOwnQueries(site, { deps });
    assert.equal(r.code, 'no_search_data');
    assert.equal(calls.saved.length, 0);
    assert.equal(calls.status[0].status, 'skipped');
    assert.match(calls.status[0].message, /Search Console/);
  });
  test('only new, non-brand queries are saved, labelled gsc_own_queries, for this project only', async () => {
    const { calls, deps } = mk({ gsc: [row('track ai overviews', 90, 11), row('superrank pricing', 200, 6)], topics: [] });
    const r = await discoverKeywordsFromOwnQueries(site, { deps });
    assert.equal(r.saved, 1);
    assert.equal(calls.saved[0].siteId, 8871);
    assert.equal(calls.saved[0].source, 'gsc_own_queries');
    assert.deepEqual(calls.saved[0].gaps.map((g) => g.topic), ['track ai overviews']);
    assert.ok(calls.queries.every((p) => p[0] === 8871), 'every query is scoped to this project');
    assert.equal(calls.status[0].status, 'ok');
    assert.equal(calls.status[0].keywords, 1);
  });
  test('everything already known: a normal "nothing new" status, not a failure', async () => {
    const { calls, deps } = mk({ gsc: [row('track ai overviews', 90, 11)], topics: ['Track AI Overviews'] });
    const r = await discoverKeywordsFromOwnQueries(site, { deps });
    assert.equal(r.status, 'nothing_new');
    assert.equal(calls.saved.length, 0);
  });
});
