import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSerpUrl, overlapScore, relateKeywords, clusterBySerp, pairsToCompare, RELATION } from './serp-overlap.js';

// n distinct result URLs on distinct sites; shared(a, b, k) gives two result lists that share exactly k of their 10.
const urls = (prefix, n = 10) => Array.from({ length: n }, (_, i) => `https://${prefix}${i}.example/page`);
function shared(k, over = {}) {
  const common = urls('common', k);
  return [{ urls: [...common, ...urls('a', 10 - k)], ...over.a }, { urls: [...common, ...urls('b', 10 - k)], ...over.b }];
}

describe('normalizeSerpUrl', () => {
  test('protocol, www, trailing slash, query and fragment do not make a different page', () => {
    const base = normalizeSerpUrl('https://www.Example.com/blog/post/');
    assert.equal(base, 'example.com/blog/post');
    for (const v of ['http://example.com/blog/post', 'https://example.com/blog/post?utm_source=x', 'https://example.com/blog/post/#top']) assert.equal(normalizeSerpUrl(v), base, v);
    assert.notEqual(normalizeSerpUrl('https://example.com/blog/other'), base);
  });
  test('the home page and junk', () => { assert.equal(normalizeSerpUrl('https://example.com/'), 'example.com'); assert.equal(normalizeSerpUrl('not a url'), ''); assert.equal(normalizeSerpUrl(null), ''); });
});

describe('overlapScore', () => {
  test('counts shared pages, ignoring duplicates and formatting', () => {
    assert.equal(overlapScore(['https://a.com/x', 'https://a.com/x/', 'https://b.com/y'], ['http://www.a.com/x', 'https://c.com']), 1);
    assert.equal(overlapScore([], ['https://a.com']), 0);
    assert.equal(overlapScore(urls('x'), urls('x')), 10);
  });
});

describe('relateKeywords — the bands', () => {
  test('7-10 shared: the same page', () => { for (const k of [7, 8, 10]) assert.equal(relateKeywords(...shared(k)).relation, RELATION.SAME_PAGE, `${k}`); });
  test('5-6 shared: the same cluster', () => { for (const k of [5, 6]) assert.equal(relateKeywords(...shared(k)).relation, RELATION.SAME_CLUSTER, `${k}`); });
  test('2 shared: interlink. 0-1 shared: separate', () => {
    assert.equal(relateKeywords(...shared(2)).relation, RELATION.INTERLINK);
    assert.equal(relateKeywords(...shared(1)).relation, RELATION.SEPARATE);
    assert.equal(relateKeywords(...shared(0)).relation, RELATION.SEPARATE);
  });
  test('4 shared stays a cluster by default (errs toward cohesion), unless one keyword has 10x the volume', () => {
    assert.equal(relateKeywords(...shared(4)).relation, RELATION.SAME_CLUSTER);
    assert.equal(relateKeywords(...shared(4, { a: { volume: 10000 }, b: { volume: 900 } })).relation, RELATION.INTERLINK);
    assert.equal(relateKeywords(...shared(4, { a: { volume: 5000 }, b: { volume: 900 } })).relation, RELATION.SAME_CLUSTER, 'a 5x gap is not enough');
  });
  test('3 shared is interlink, promoted to a cluster only when intent AND sites agree and no volume gap', () => {
    assert.equal(relateKeywords(...shared(3)).relation, RELATION.INTERLINK);
    assert.equal(relateKeywords(...shared(3, { a: { intent: 'commercial' }, b: { intent: 'commercial' } })).relation, RELATION.INTERLINK, 'same intent alone is not enough');
    // same sites: results on the same 10 domains, different pages except 3
    const sites = Array.from({ length: 10 }, (_, i) => `https://site${i}.example`);
    const a = { urls: sites.map((s, i) => `${s}/${i < 3 ? 'same' : 'a'}`), intent: 'commercial' };
    const b = { urls: sites.map((s, i) => `${s}/${i < 3 ? 'same' : 'b'}`), intent: 'commercial' };
    assert.equal(relateKeywords(a, b).relation, RELATION.SAME_CLUSTER);
    assert.equal(relateKeywords(a, { ...b, volume: 100 }).relation, RELATION.SAME_CLUSTER, 'a missing volume is not a gap');
    assert.equal(relateKeywords({ ...a, volume: 20000 }, { ...b, volume: 100 }).relation, RELATION.INTERLINK);
  });
  test('says why, in words', () => assert.match(relateKeywords(...shared(8)).reason, /8 of the top 10/));
});

describe('clusterBySerp', () => {
  const kw = (keyword, urlsList, volume) => ({ keyword, urls: urlsList, volume });
  const fam = (name, k) => [...urls(`${name}-shared`, k), ...urls(`${name}-own-${Math.random().toString(36).slice(2, 6)}`, 10 - k)];

  test('keywords that share 7+ results become ONE page, with the highest-volume keyword as primary', () => {
    const core = urls('core', 8);
    const r = clusterBySerp([
      kw('best crm software', [...core, ...urls('p', 2)], 5000),
      kw('top crm software', [...core, ...urls('q', 2)], 1200),
      kw('crm for plumbers', urls('plumb', 10), 300),
    ]);
    assert.deepEqual(r.pages.find((p) => p.keywords.length === 2), { primary: 'best crm software', keywords: ['best crm software', 'top crm software'] });
    assert.equal(r.pages.length, 2);
  });

  test('merging is transitive: A~B and B~C put all three on one page', () => {
    const x = urls('x', 7); const y = urls('y', 7);
    const r = clusterBySerp([kw('a', [...x, 'https://only-a.example/1', 'https://only-a.example/2', 'https://only-a.example/3'], 1), kw('b', [...x.slice(0, 7), ...y.slice(0, 3)], 2), kw('c', [...y.slice(0, 7), 'https://only-c.example/1', 'https://only-c.example/2', 'https://only-c.example/3'], 3)]);
    // a-b share 7, b-c share 3 (not enough): a and b merge, c stays separate
    assert.deepEqual(r.pages.map((p) => p.keywords), [['a', 'b'], ['c']]);
  });

  test('4-6 shared results put separate pages in one topic cluster; 2-3 shared ask for a link between them', () => {
    const base = urls('base', 10);
    const clusterPeer = [...base.slice(0, 5), ...urls('peer', 5)];
    const linkPeer = [...base.slice(0, 2), ...urls('lp', 8)];
    const r = clusterBySerp([kw('pillar', base, 9000), kw('cluster peer', clusterPeer, 800), kw('link peer', linkPeer, 700), kw('unrelated', urls('zzz', 10), 600)]);
    assert.equal(r.pages.length, 4);
    assert.deepEqual(r.clusters, [['cluster peer', 'pillar']]);
    assert.ok(r.links.some(([x, y]) => [x, y].sort().join() === ['link peer', 'pillar'].sort().join()), 'link peer should link to the pillar');
    assert.ok(!r.links.flat().includes('unrelated'));
  });

  test('keywords with no results are skipped, not grouped', () => {
    const r = clusterBySerp([kw('has results', urls('h', 10), 1), kw('empty', [], 1), kw('junk', ['not a url'], 1)]);
    assert.deepEqual(r.skipped.sort(), ['empty', 'junk']);
    assert.equal(r.pages.length, 1);
  });

  test('no keywords, one keyword', () => {
    assert.deepEqual(clusterBySerp([]), { pages: [], clusters: [], links: [], skipped: [] });
    assert.deepEqual(clusterBySerp([kw('solo', urls('s', 10), 5)]).pages, [{ primary: 'solo', keywords: ['solo'] }]);
  });

  test('deterministic: the same input in a different order gives the same answer', () => {
    const list = [kw('a one', urls('m', 10), 5), kw('a two', urls('m', 9), 7), kw('b one', urls('n', 10), 3)];
    assert.deepEqual(clusterBySerp(list), clusterBySerp([...list].reverse()));
  });
});

describe('pairsToCompare (cuts the number of lookups)', () => {
  test('compares inside each head-term group, plus the top keyword of each group against the others', () => {
    const ks = [{ keyword: 'crm software', volume: 100 }, { keyword: 'crm tools', volume: 900 }, { keyword: 'crm pricing', volume: 50 }, { keyword: 'seo audit', volume: 700 }, { keyword: 'seo report', volume: 80 }];
    const pairs = pairsToCompare(ks).map((p) => [...p].sort().join(' | '));
    assert.ok(pairs.includes('crm software | crm tools') && pairs.includes('crm pricing | crm tools') && pairs.includes('seo audit | seo report'));
    assert.ok(pairs.includes('crm tools | seo audit'), 'the group tops are compared across groups');
    assert.ok(!pairs.includes('crm pricing | seo report'), 'a non-top across groups is NOT compared');
    // 40 keywords in 4 groups of 10: far fewer than the 780 full pairs
    const big = Array.from({ length: 40 }, (_, i) => ({ keyword: `g${i % 4} k${i}`, volume: i }));
    assert.ok(pairsToCompare(big).length < 780 / 3);
  });
});
