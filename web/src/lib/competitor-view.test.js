import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompetitorView, buildStory, normDomain } from './competitor-view.js';

const own = { domain: 'me.com', referringDomains: 100 };
const comp = (id, domain, ownScore, competitorScore, source = 'serp') => ({ id, domain, comparison: { ownScore, competitorScore, discoverySource: source, verdict: `${domain} verdict` } });

describe('normDomain', () => {
  test('strips scheme, www, path and case', () => assert.equal(normDomain('HTTPS://www.Rival.com/blog'), 'rival.com'));
});

describe('buildCompetitorView', () => {
  const backlinkComparison = { ownDomain: own, competitors: [{ domain: 'www.big.com', referringDomains: 800 }, { domain: 'small.com', referringDomains: 40 }], strongestProfile: { domain: 'big.com', referringDomains: 800 }, largestGap: { domain: 'big.com', gap: 700 } };
  const rankingComparison = { checked: true, rows: [{ query: 'a', competitorDomain: 'big.com', competitorPosition: 2, ownPosition: 9, impressions: 50 }, { query: 'b', competitorDomain: 'big.com', competitorPosition: 1, ownPosition: null, impressions: 90 }] };

  test('counts only measures with real data and says who leads on each', () => {
    const v = buildCompetitorView({ competitors: [comp(1, 'big.com', 60, 80), comp(2, 'small.com', 60, 40)], backlinkComparison, rankingComparison });
    const big = v.cards.find((c) => c.domain === 'big.com');
    assert.equal(big.total, 3);
    assert.equal(big.aheadN, 3);
    assert.equal(big.measures.find((m) => m.key === 'links').detail, '8.0x as many');
    assert.equal(big.measures.find((m) => m.key === 'content').detail, '20 points better');
    assert.deepEqual(big.searches.map((s) => s.query), ['b', 'a'], 'most-impressions search first');
    const small = v.cards.find((c) => c.domain === 'small.com');
    assert.equal(small.aheadN, 0);
    assert.equal(small.leadsYou, false);
    assert.equal(small.measures.find((m) => m.key === 'links').detail, 'you have more');
    assert.equal(small.measures.find((m) => m.key === 'searches').detail, 'none');
  });

  test('most threatening competitor is listed first', () => {
    const v = buildCompetitorView({ competitors: [comp(2, 'small.com', 60, 40), comp(1, 'big.com', 60, 80)], backlinkComparison, rankingComparison });
    assert.equal(v.cards[0].domain, 'big.com');
    assert.equal(v.aheadCount, 1);
  });

  test('no backlink data and no ranking check: those measures are left out, not invented', () => {
    const v = buildCompetitorView({ competitors: [comp(1, 'big.com', 60, 80)], backlinkComparison: null, rankingComparison: null });
    assert.deepEqual(v.cards[0].measures.map((m) => m.key), ['content']);
    assert.equal(v.cards[0].total, 1);
  });

  test('a competitor with nothing comparable is never "ahead"', () => {
    const v = buildCompetitorView({ competitors: [{ id: 1, domain: 'x.com', comparison: {} }] });
    assert.equal(v.cards[0].total, 0);
    assert.equal(v.cards[0].leadsYou, false);
  });

  test('discovery source becomes a plain label', () => {
    const v = buildCompetitorView({ competitors: [comp(1, 'a.com', 1, 1, 'forced'), comp(2, 'b.com', 1, 1, 'llm')] });
    assert.deepEqual(v.cards.map((c) => c.source).sort(), ['Added by you', 'Found by AI research']);
  });
});

describe('buildStory', () => {
  test('only says what the data backs', () => {
    const v = buildCompetitorView({
      competitors: [comp(1, 'big.com', 60, 80), comp(2, 'small.com', 60, 40), comp(3, 'tiny.com', 60, 30)],
      backlinkComparison: { ownDomain: own, competitors: [{ domain: 'big.com', referringDomains: 800 }, { domain: 'small.com', referringDomains: 50 }, { domain: 'tiny.com', referringDomains: 10 }], strongestProfile: { domain: 'big.com' }, largestGap: { domain: 'big.com', gap: 700 } },
    });
    const s = buildStory(v);
    assert.match(s, /1 of your 3 competitors is ahead/);
    assert.match(s, /big\.com has 800 other websites pointing to it, and you have 100/);
    assert.match(s, /easier to read and quote than most/);
  });
  test('no competitors, no story', () => assert.equal(buildStory(buildCompetitorView({})), null));
  test('no link data means no link sentence', () => {
    const s = buildStory(buildCompetitorView({ competitors: [comp(1, 'a.com', 60, 80)] }));
    assert.doesNotMatch(s, /links|pointing/);
  });
});
