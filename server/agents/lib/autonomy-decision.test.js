import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRecommendation, summarizeAutonomy, AUTONOMY_DECISION } from './autonomy-decision.js';

describe('classifyRecommendation', () => {
  test('safe tier, nothing blocking -> SAFE_TO_AUTO_EXECUTE', () => {
    const d = classifyRecommendation({ risk_tier: 'safe', blocked_reason: null, status: 'open' });
    assert.equal(d.decision, AUTONOMY_DECISION.SAFE_TO_AUTO_EXECUTE);
  });

  test('manual tier -> NEEDS_HUMAN_REVIEW', () => {
    const d = classifyRecommendation({ risk_tier: 'manual', blocked_reason: null, status: 'open' });
    assert.equal(d.decision, AUTONOMY_DECISION.NEEDS_HUMAN_REVIEW);
  });

  test('a blocked recommendation is NEEDS_HUMAN_REVIEW even if the generator is otherwise safe', () => {
    // The real bug auto-remediation.js's own comment documents: site 1 had
    // 45 rows with risk_tier='safe' AND a blocked_reason. blocked_reason
    // must win regardless of tier, or the loop attempts something it cannot
    // honestly draft.
    const d = classifyRecommendation({ risk_tier: 'safe', blocked_reason: 'design language not derived yet', status: 'open' });
    assert.equal(d.decision, AUTONOMY_DECISION.NEEDS_HUMAN_REVIEW);
    assert.match(d.reason, /design language/);
  });

  test('a resolved/dismissed recommendation is UNSAFE_REJECTED regardless of tier', () => {
    const d = classifyRecommendation({ risk_tier: 'safe', blocked_reason: null, status: 'dismissed' });
    assert.equal(d.decision, AUTONOMY_DECISION.UNSAFE_REJECTED);
  });

  test('no recommendation is a safe refusal, never a crash', () => {
    assert.equal(classifyRecommendation(null).decision, AUTONOMY_DECISION.UNSAFE_REJECTED);
  });
});

describe('summarizeAutonomy', () => {
  test('buckets a mixed set correctly and never drops an item', () => {
    const recs = [
      { id: 1, risk_tier: 'safe', blocked_reason: null, status: 'open' },
      { id: 2, risk_tier: 'manual', blocked_reason: null, status: 'open' },
      { id: 3, risk_tier: 'safe', blocked_reason: 'x', status: 'open' },
      { id: 4, risk_tier: 'safe', blocked_reason: null, status: 'dismissed' },
    ];
    const s = summarizeAutonomy(recs);
    assert.deepEqual(s.safeToAutoExecute.map((x) => x.id), [1]);
    assert.deepEqual(s.needsHumanReview.map((x) => x.id), [2, 3]);
    assert.deepEqual(s.unsafeRejected.map((x) => x.id), [4]);
  });

  test('an empty/missing list summarizes to all-empty buckets, not an error', () => {
    const s = summarizeAutonomy(undefined);
    assert.deepEqual(s.safeToAutoExecute, []);
    assert.deepEqual(s.needsHumanReview, []);
    assert.deepEqual(s.unsafeRejected, []);
  });
});
