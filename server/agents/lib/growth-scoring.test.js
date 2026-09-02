import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRecommendation, demandScore, breadthScore, confidenceScore, buildPageMetrics } from './growth-scoring.js';
import { SEVERITY_TIER } from './severity-tiers.js';

function rec(overrides = {}) {
  return {
    id: 1, recommendation_type: 'meta-title', params: { page: '/p' },
    finding_ids: ['f1'], supporting_agents: [], ...overrides,
  };
}

describe('scoreRecommendation — tier dominance', () => {
  test('a critical-technical item always outranks an on-page item, regardless of demand/breadth on the lesser tier', () => {
    const critical = scoreRecommendation(rec({ recommendation_type: 'canonical' }));
    // Even with the maximum plausible demand+breadth+confidence bonuses, an
    // on-page item must never cross into critical-technical's range — tiers
    // are separated by STEP (1000), and every within-tier component is
    // bounded well under that.
    const onPageMaxed = scoreRecommendation(rec({ recommendation_type: 'meta-title', supporting_agents: ['a', 'b', 'c'], finding_ids: ['f1', 'f2', 'f3'] }), {
      pageMetrics: new Map([['/p', { impressions: 1_000_000, avgPosition: 11, ctr: 0.001 }]]),
      learnedMap: new Map([['meta-title', { confidence: 1, impactConfidence: 1 }]]),
    });
    assert.ok(critical.score > onPageMaxed.score, `critical ${critical.score} must exceed maxed on-page ${onPageMaxed.score}`);
  });

  test('tier assignment matches severity-tiers.js', () => {
    assert.equal(scoreRecommendation(rec({ recommendation_type: 'canonical' })).tier, SEVERITY_TIER.CRITICAL_TECHNICAL);
    assert.equal(scoreRecommendation(rec({ recommendation_type: 'blog-outline' })).tier, SEVERITY_TIER.CONTENT);
  });
});

describe('demandScore — real GSC signals, bounded and additive', () => {
  test('no metrics at all scores zero', () => {
    assert.deepEqual(demandScore(null), { score: 0, factors: [] });
    assert.deepEqual(demandScore({ impressions: 0 }), { score: 0, factors: [] });
  });

  test('impressions alone contribute, log-scaled', () => {
    const low = demandScore({ impressions: 10, avgPosition: null, ctr: 0 });
    const high = demandScore({ impressions: 10000, avgPosition: null, ctr: 0 });
    assert.ok(high.score > low.score);
    assert.ok(high.score <= 300, 'stays within DEMAND_CAP');
  });

  test('a page ranking 10-20 (near page 1) earns a distance bonus', () => {
    const near = demandScore({ impressions: 500, avgPosition: 15, ctr: 0.02 });
    assert.ok(near.factors.some((f) => f.includes('near-page-1')));
  });

  test('a page ranking well but under-clicked for its position earns a CTR-gap bonus', () => {
    const gap = demandScore({ impressions: 1000, avgPosition: 3, ctr: 0.01 }); // real CTR at pos 3 is much higher
    assert.ok(gap.factors.some((f) => f.includes('ctr-gap')));
  });

  test('a page ranking well WITH good CTR earns no ctr-gap bonus', () => {
    const healthy = demandScore({ impressions: 1000, avgPosition: 1, ctr: 0.3 });
    assert.ok(!healthy.factors.some((f) => f.includes('ctr-gap')));
  });
});

describe('breadthScore — root-cause groups and corroboration', () => {
  test('a solo item (group size 1) earns no group bonus', () => {
    assert.equal(breadthScore(rec(), 1).score, 0);
  });

  test('a larger root-cause group scores higher than a smaller one, sub-linearly', () => {
    const small = breadthScore(rec(), 2).score;
    const large = breadthScore(rec(), 20).score;
    assert.ok(large > small);
    // log2-scaled: 10x the members (2 -> 20) must not be worth anywhere near
    // 10x the score — a group's SIZE matters, but not proportionally.
    assert.ok(large < small * 10, `10x the members must not be worth 10x the score (${small} -> ${large})`);
  });

  test('the group bonus saturates rather than growing unbounded for very large groups', () => {
    const large = breadthScore(rec(), 20).score;
    const huge = breadthScore(rec(), 200).score;
    assert.equal(huge, large, 'both already hit the per-component cap — a 200-member group is not worth more than a 20-member one');
  });

  test('merged findings and corroborating agents each add a bounded bonus', () => {
    const merged = breadthScore(rec({ finding_ids: ['f1', 'f2', 'f3'] }), 1);
    assert.ok(merged.score > 0);
    const corroborated = breadthScore(rec({ supporting_agents: ['agent-a', 'agent-b'] }), 1);
    assert.ok(corroborated.score > 0);
  });
});

describe('confidenceScore — learned outcome history, neutral when absent', () => {
  test('no learned entry at all scores zero, never penalized', () => {
    assert.deepEqual(confidenceScore(rec(), undefined), { score: 0, factors: [] });
  });

  test('above-neutral confidence/impactConfidence scores positive; below-neutral scores negative', () => {
    const good = confidenceScore(rec(), { confidence: 0.9, impactConfidence: 0.9 });
    const bad = confidenceScore(rec(), { confidence: 0.1, impactConfidence: 0.1 });
    assert.ok(good.score > 0);
    assert.ok(bad.score < 0);
  });

  test('exactly neutral (0.5/0.5) contributes nothing', () => {
    assert.equal(confidenceScore(rec(), { confidence: 0.5, impactConfidence: 0.5 }).score, 0);
  });
});

describe('buildPageMetrics — aggregates per-(query,page) rows into per-page metrics', () => {
  test('sums impressions/clicks and impression-weights position across queries on the same page', () => {
    const rows = [
      { page: '/p', impressions: 100, clicks: 5, avgPosition: 10 },
      { page: '/p', impressions: 300, clicks: 15, avgPosition: 20 },
    ];
    const map = buildPageMetrics(rows);
    const m = map.get('/p');
    assert.equal(m.impressions, 400);
    assert.equal(m.clicks, 20);
    assert.equal(m.ctr, 20 / 400);
    // weighted: (100*10 + 300*20) / 400 = 17.5
    assert.equal(m.avgPosition, 17.5);
  });

  test('a row with no page is dropped, never crashes', () => {
    const map = buildPageMetrics([{ page: null, impressions: 5, clicks: 1 }]);
    assert.equal(map.size, 0);
  });

  test('empty input returns an empty map', () => {
    assert.equal(buildPageMetrics([]).size, 0);
    assert.equal(buildPageMetrics(undefined).size, 0);
  });
});
