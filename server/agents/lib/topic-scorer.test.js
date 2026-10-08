import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreTopicCandidate, rankTopicCandidates, demandTierFor, normalizeVolume,
  trendStrengthScore, topicKeyFor, isTopicScorerEnabled,
} from './topic-scorer.js';

const measured = (searchVolume, over = {}) => ({
  available: true, providerId: 'dataforseo', searchVolume, volumeTrend: null, ...over,
});

describe('normalizeVolume', () => {
  test('no volume is zero, and a nonsense value does not become NaN', () => {
    assert.equal(normalizeVolume(0), 0);
    assert.equal(normalizeVolume(null), 0);
    assert.equal(normalizeVolume('abc'), 0);
    assert.equal(normalizeVolume(-5), 0);
  });

  test('a fifty-times-bigger term is better but nowhere near fifty times better', () => {
    // Linear scaling would let one broad head term erase every other
    // component of the score.
    const small = normalizeVolume(1000);
    const big = normalizeVolume(50000);
    assert.ok(big > small);
    assert.ok(big / small < 2.5, `expected a compressed ratio, got ${big / small}`);
  });

  test('saturates at 1 rather than growing without bound', () => {
    assert.equal(normalizeVolume(5_000_000), 1);
  });
});

describe('demandTierFor', () => {
  test('a real volume is measured demand', () => {
    assert.equal(demandTierFor({ demand: measured(900) }), 'measured');
  });

  test('a live provider with a rising trend but no volume is still above a trend feed', () => {
    assert.equal(demandTierFor({ demand: { available: true, searchVolume: null, volumeTrend: 'rising' } }), 'trend-verified');
  });

  test('headlines alone are trend-only, not demand', () => {
    assert.equal(demandTierFor({ trendStrength: 0.8 }), 'trend-only');
  });

  test("an unavailable provider's zero does not become measured demand", () => {
    // The null provider, and a real provider reporting no measurable volume,
    // both return available:false. Treating that as volume 0 or as measured
    // would be the exact confident-wrong number this layer prevents.
    assert.equal(demandTierFor({ demand: { available: false, searchVolume: null } }), 'none');
  });

  test('an LLM estimate is the last tier, and only when nothing else exists', () => {
    assert.equal(demandTierFor({ llmEstimatedVolume: 5000 }), 'llm-guess');
    assert.equal(demandTierFor({ llmEstimatedVolume: 5000, trendStrength: 0.4 }), 'trend-only');
  });

  test('the tier is derived from the evidence, never declared by the caller', () => {
    // No pipeline can promote its own topics by labelling them.
    assert.equal(demandTierFor({ demandTier: 'measured', demand: null }), 'none');
  });
});

describe('trendStrengthScore', () => {
  test('no sources is no trend', () => {
    assert.equal(trendStrengthScore({}), 0);
  });

  test('more distinct outlets beats more headlines from one', () => {
    const broad = trendStrengthScore({ distinctSources: 3, newestAgeDays: 1 });
    const narrow = trendStrengthScore({ distinctSources: 1, newestAgeDays: 1 });
    assert.ok(broad > narrow);
  });

  test('a week-old story scores below a fresh one', () => {
    assert.ok(trendStrengthScore({ distinctSources: 3, newestAgeDays: 0 }) > trendStrengthScore({ distinctSources: 3, newestAgeDays: 7 }));
  });
});

describe('scoreTopicCandidate — drops', () => {
  test('a claimed topic is dropped before any scoring', () => {
    const out = scoreTopicCandidate({ topic: 'x', demand: measured(90000), claimed: true });
    assert.equal(out.dropped, 'claimed-by-another-producer');
    assert.equal(out.score, 0);
  });

  test('a suppressed topic is dropped', () => {
    assert.equal(scoreTopicCandidate({ topic: 'x', suppressed: true }).dropped, 'suppressed');
  });

  test('a covered or duplicate topic is dropped with the reason, not scored to zero', () => {
    assert.equal(scoreTopicCandidate({ topic: 'x', coverageStatus: 'covered' }).dropped, 'already-covered');
    assert.equal(scoreTopicCandidate({ topic: 'x', coverageStatus: 'duplicate' }).dropped, 'duplicate-of-existing-page');
  });

  test('an empty topic is dropped rather than producing a keyless row', () => {
    assert.equal(scoreTopicCandidate({ topic: '   ' }).dropped, 'no-topic');
  });
});

describe('scoreTopicCandidate — demand', () => {
  test('a measured topic outranks an equally-relevant trending one', () => {
    const base = { coverageStatus: 'opportunity', relevance: { productRelevance: 'core', confidence: 'high' } };
    const searched = scoreTopicCandidate({ ...base, topic: 'a', origin: 'keyword-gap', demand: measured(4000) });
    const trending = scoreTopicCandidate({ ...base, topic: 'b', origin: 'trend-radar', trend: { distinctSources: 3, newestAgeDays: 0 } });

    assert.ok(searched.score > trending.score, `${searched.score} should beat ${trending.score}`);
  });

  test('a hot trend with no volume history is not banned, only outranked', () => {
    const out = scoreTopicCandidate({
      topic: 'b', origin: 'trend-radar', coverageStatus: 'opportunity',
      trend: { distinctSources: 4, newestAgeDays: 0 },
    });
    assert.equal(out.dropped, null);
    assert.ok(out.score > 0);
  });

  test('a topic BOTH trending and searched beats either alone — the gap this module closes', () => {
    const base = { coverageStatus: 'opportunity', relevance: { productRelevance: 'core', confidence: 'high' } };
    const both = scoreTopicCandidate({
      ...base, topic: 'a', origin: 'keyword-gap', sources: ['keyword-gap', 'trend-radar'],
      demand: measured(4000), trend: { distinctSources: 3, newestAgeDays: 0 },
    });
    const searchedOnly = scoreTopicCandidate({ ...base, topic: 'b', origin: 'keyword-gap', demand: measured(4000) });

    assert.ok(both.score > searchedOnly.score);
    assert.equal(both.components.corroborationMultiplier, 1.25);
    assert.deepEqual(both.components.sources, ['keyword-gap', 'trend-radar']);
  });

  test('a duplicated source name does not count as corroboration', () => {
    const out = scoreTopicCandidate({ topic: 'a', origin: 'keyword-gap', sources: ['keyword-gap', 'keyword-gap'] });
    assert.equal(out.components.corroborationMultiplier, 1);
  });

  test('the demand tier and the real volume are both recorded on the score', () => {
    const out = scoreTopicCandidate({ topic: 'a', demand: measured(1234, { volumeTrend: 'rising' }), coverageStatus: 'opportunity' });
    assert.equal(out.components.demandTier, 'measured');
    assert.equal(out.components.searchVolume, 1234);
    assert.equal(out.components.volumeTrend, 'rising');
  });

  test('an unavailable provider leaves searchVolume null on the row, never 0', () => {
    const out = scoreTopicCandidate({ topic: 'a', demand: { available: false, searchVolume: null, note: 'none configured' } });
    assert.equal(out.components.searchVolume, null);
  });
});

describe('scoreTopicCandidate — relevance and goals', () => {
  test('a tenant with no relevance evidence is not scored to zero', () => {
    // The bug this guards: treating absence of evidence as evidence of
    // irrelevance is what stopped every product tenant from shipping any
    // keyword gap at all.
    const out = scoreTopicCandidate({ topic: 'a', demand: measured(1000), coverageStatus: 'opportunity' });
    assert.ok(out.score > 0);
    assert.equal(out.components.relevanceMultiplier, 1);
  });

  test('low-confidence relevance is damped toward neutral, never below it', () => {
    const high = scoreTopicCandidate({ topic: 'a', demand: measured(1000), coverageStatus: 'opportunity', relevance: { productRelevance: 'core', confidence: 'high' } });
    const low = scoreTopicCandidate({ topic: 'a', demand: measured(1000), coverageStatus: 'opportunity', relevance: { productRelevance: 'core', confidence: 'low' } });
    const unknown = scoreTopicCandidate({ topic: 'a', demand: measured(1000), coverageStatus: 'opportunity' });

    assert.ok(high.score > low.score);
    assert.ok(low.score > unknown.score, 'a weakly-evidenced core topic must not fall below an unknown one');
  });

  test('an unrelated topic is pushed down but a low-confidence verdict cannot bury it', () => {
    const confident = scoreTopicCandidate({ topic: 'a', demand: measured(1000), coverageStatus: 'opportunity', relevance: { productRelevance: 'unrelated', confidence: 'high' } });
    const shaky = scoreTopicCandidate({ topic: 'a', demand: measured(1000), coverageStatus: 'opportunity', relevance: { productRelevance: 'unrelated', confidence: 'low' } });
    assert.ok(shaky.score > confident.score);
  });

  test('goal alignment adds and never subtracts', () => {
    const none = scoreTopicCandidate({ topic: 'a', demand: measured(1000), coverageStatus: 'opportunity' });
    const strong = scoreTopicCandidate({ topic: 'a', demand: measured(1000), coverageStatus: 'opportunity', goalAlignment: { level: 'strong' } });

    assert.ok(strong.score > none.score);
    assert.equal(none.components.goalMultiplier, 1, 'a tenant with no goals must not score every topic at zero');
  });
});

describe('scoreTopicCandidate — coverage headroom', () => {
  test('a confirmed opportunity beats an uncertain one', () => {
    const open = scoreTopicCandidate({ topic: 'a', demand: measured(1000), coverageStatus: 'opportunity' });
    const unsure = scoreTopicCandidate({ topic: 'a', demand: measured(1000), coverageStatus: 'uncertain' });
    assert.ok(open.score > unsure.score);
  });

  test('a market or language gap is real headroom, discounted rather than dropped', () => {
    for (const status of ['market_gap', 'language_gap', 'intent_gap']) {
      const out = scoreTopicCandidate({ topic: 'a', demand: measured(1000), coverageStatus: status });
      assert.equal(out.dropped, null, status);
      assert.ok(out.score > 0, status);
    }
  });

  test('an unclassified topic sits between opportunity and uncertain, not at either extreme', () => {
    const unclassified = scoreTopicCandidate({ topic: 'a', demand: measured(1000) });
    const open = scoreTopicCandidate({ topic: 'a', demand: measured(1000), coverageStatus: 'opportunity' });
    const unsure = scoreTopicCandidate({ topic: 'a', demand: measured(1000), coverageStatus: 'uncertain' });

    assert.ok(unclassified.score < open.score);
    assert.ok(unclassified.score > unsure.score);
  });
});

describe('rankTopicCandidates', () => {
  test('ranks best first, caps the queue, and keeps the overflow', () => {
    const candidates = [
      { topic: 'low', demand: measured(50), coverageStatus: 'opportunity' },
      { topic: 'high', demand: measured(20000), coverageStatus: 'opportunity' },
      { topic: 'mid', demand: measured(2000), coverageStatus: 'opportunity' },
    ];
    const out = rankTopicCandidates(candidates, { limit: 2 });

    assert.deepEqual(out.queued.map((q) => q.topic), ['high', 'mid']);
    assert.deepEqual(out.overflow.map((q) => q.topic), ['low']);
  });

  test('dropped candidates are returned with their reason, never silently discarded', () => {
    const out = rankTopicCandidates([
      { topic: 'covered one', coverageStatus: 'covered' },
      { topic: 'fine one', demand: measured(100), coverageStatus: 'opportunity' },
    ]);

    assert.deepEqual(out.queued.map((q) => q.topic), ['fine one']);
    assert.equal(out.dropped.length, 1);
    assert.equal(out.dropped[0].dropped, 'already-covered');
  });

  test('ties break deterministically, so two runs produce the same order', () => {
    const made = () => rankTopicCandidates([
      { topic: 'beta', demand: measured(1000), coverageStatus: 'opportunity' },
      { topic: 'alpha', demand: measured(1000), coverageStatus: 'opportunity' },
    ]).queued.map((q) => q.topic);

    assert.deepEqual(made(), ['alpha', 'beta']);
    assert.deepEqual(made(), made());
  });

  test('an empty batch is an empty queue, not an error', () => {
    const out = rankTopicCandidates([]);
    assert.deepEqual(out.queued, []);
    assert.deepEqual(out.dropped, []);
  });
});

describe('topicKeyFor', () => {
  test('casing and punctuation do not produce two keys for one topic', () => {
    assert.equal(topicKeyFor('Study in India, from Nepal!'), topicKeyFor('study in india from nepal'));
  });
});

describe('isTopicScorerEnabled', () => {
  test('off unless explicitly turned on', () => {
    assert.equal(isTopicScorerEnabled({}), false);
    assert.equal(isTopicScorerEnabled({ TOPIC_SCORER_ENABLED: 'false' }), false);
    assert.equal(isTopicScorerEnabled({ TOPIC_SCORER_ENABLED: 'true' }), true);
  });
});
