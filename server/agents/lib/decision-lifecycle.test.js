import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canAdvance, advanceDecision, advanceDecisionForRecommendation,
  outcomeRefForFixImpact, DECISION_STATUSES,
} from './decision-lifecycle.js';

describe('canAdvance', () => {
  test('forward progress is allowed', () => {
    assert.equal(canAdvance('decided', 'executing'), true);
    assert.equal(canAdvance('executing', 'shipped'), true);
    assert.equal(canAdvance('shipped', 'verified'), true);
    assert.equal(canAdvance('decided', 'verified'), true, 'skipping a stage is still progress');
  });

  test('a late-arriving earlier stage cannot walk a decision backwards', () => {
    // These transitions arrive from five independent cron lanes with no
    // ordering between them, so this is the rule that keeps the column
    // meaningful.
    assert.equal(canAdvance('shipped', 'executing'), false);
    assert.equal(canAdvance('verified', 'shipped'), false);
  });

  test('failure is reachable from any non-terminal state', () => {
    assert.equal(canAdvance('decided', 'failed'), true);
    assert.equal(canAdvance('executing', 'failed'), true);
    assert.equal(canAdvance('shipped', 'failed'), true);
  });

  test('verified and failed are terminal', () => {
    for (const to of DECISION_STATUSES) {
      assert.equal(canAdvance('verified', to), false, `verified -> ${to}`);
      assert.equal(canAdvance('failed', to), false, `failed -> ${to}`);
    }
  });

  test('a no-op and an unknown status are both refused', () => {
    assert.equal(canAdvance('shipped', 'shipped'), false);
    assert.equal(canAdvance('decided', 'nonsense'), false);
  });
});

function fakeStore({ decision, decisionIdForRecommendation = async () => null } = {}) {
  const writes = [];
  return {
    writes,
    deps: {
      getDecision: async (id) => (decision && decision.id === id ? decision : null),
      setOutcome: async (id, patch) => { writes.push({ id, ...patch }); return { ...decision, ...patch }; },
      decisionIdForRecommendation,
    },
  };
}

describe('advanceDecision', () => {
  test('advances and records the outcome reference', async () => {
    const { deps, writes } = fakeStore({ decision: { id: 7, status: 'shipped', outcome_ref: null } });
    await advanceDecision(7, 'verified', { outcomeRef: outcomeRefForFixImpact(42), deps });

    assert.deepEqual(writes, [{ id: 7, status: 'verified', outcomeRef: 'fix_impact:42' }]);
  });

  test('a refused regression writes nothing', async () => {
    const { deps, writes } = fakeStore({ decision: { id: 7, status: 'verified', outcome_ref: 'fix_impact:1' } });
    const out = await advanceDecision(7, 'executing', { deps });

    assert.equal(out, null);
    assert.deepEqual(writes, []);
  });

  test('a late outcome reference still lands even when the status cannot move', async () => {
    // The loop closing in the status column but not in the data is the one
    // case worth handling specially: a verified decision with no reference
    // forward to its measurement has learned nothing.
    const { deps, writes } = fakeStore({ decision: { id: 7, status: 'verified', outcome_ref: null } });
    await advanceDecision(7, 'shipped', { outcomeRef: 'fix_impact:9', deps });

    assert.deepEqual(writes, [{ id: 7, status: 'verified', outcomeRef: 'fix_impact:9' }]);
  });

  test('an existing outcome reference is not overwritten by a refused transition', async () => {
    const { deps, writes } = fakeStore({ decision: { id: 7, status: 'verified', outcome_ref: 'fix_impact:1' } });
    await advanceDecision(7, 'shipped', { outcomeRef: 'fix_impact:2', deps });
    assert.deepEqual(writes, []);
  });

  test('a missing decision, or no id at all, is a silent no-op', async () => {
    const { deps, writes } = fakeStore({ decision: { id: 7, status: 'decided' } });
    assert.equal(await advanceDecision(999, 'shipped', { deps }), null);
    assert.equal(await advanceDecision(null, 'shipped', { deps }), null);
    assert.deepEqual(writes, []);
  });

  test('a store failure never throws into the ship path', async () => {
    // The recommendation, the draft and the PR are the real work. This is
    // the record of why it happened, and it must not be able to fail a ship.
    const deps = { getDecision: async () => { throw new Error('connection reset'); }, setOutcome: async () => {} };
    assert.equal(await advanceDecision(1, 'shipped', { deps }), null);
  });
});

describe('advanceDecisionForRecommendation', () => {
  test('resolves the decision behind the recommendation and advances it', async () => {
    const { deps, writes } = fakeStore({
      decision: { id: 7, status: 'decided' },
      decisionIdForRecommendation: async (recId) => (recId === 300 ? 7 : null),
    });

    await advanceDecisionForRecommendation(300, 'executing', { deps });
    assert.deepEqual(writes, [{ id: 7, status: 'executing', outcomeRef: null }]);
  });

  test('a recommendation with no decision is a no-op — the common case', async () => {
    // Only DEFAULT-bucket findings get a decide() call, so almost every
    // recommendation carries decision_id NULL. That path must cost one
    // indexed lookup and nothing else.
    const { deps, writes } = fakeStore({ decision: { id: 7, status: 'decided' } });
    assert.equal(await advanceDecisionForRecommendation(300, 'executing', { deps }), null);
    assert.deepEqual(writes, []);
  });

  test('no recommendation id does not reach the store at all', async () => {
    let looked = 0;
    const deps = {
      getDecision: async () => null, setOutcome: async () => {},
      decisionIdForRecommendation: async () => { looked++; return null; },
    };
    assert.equal(await advanceDecisionForRecommendation(null, 'shipped', { deps }), null);
    assert.equal(looked, 0);
  });
});

describe('outcomeRefForFixImpact', () => {
  test('formats the forward link, and refuses to format nothing', () => {
    assert.equal(outcomeRefForFixImpact(42), 'fix_impact:42');
    assert.equal(outcomeRefForFixImpact(null), null);
  });
});
