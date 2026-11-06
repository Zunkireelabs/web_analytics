import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { learnFromCompetitorOutcomes, describeLearning } from './competitor-outcome-learning.js';

// The two rules under test, because breaking either makes the system lie to itself:
//   1. only a measured outcome counts (never a PR, a merge or a deploy)
//   2. a measured change is only a win or a loss when the evidence supports it; otherwise neutral

function harness({ pending = [], verdicts = {}, claimed = true } = {}) {
  const calls = { recorded: [], marked: [], reconciled: 0 };
  const deps = {
    reconcileOpportunityLifecycles: async () => { calls.reconciled += 1; return { checked: 5, advanced: [{ gapId: 1, from: 'drafted', to: 'verified' }] }; },
    listUncountedVerifiedOutcomes: async () => pending,
    markOutcomeCounted: async (siteId, gapId) => { calls.marked.push(gapId); return claimed; },
    recordOpportunityOutcome: async (siteId, type, outcome) => { calls.recorded.push({ type, outcome }); },
    getLearnedMultipliers: async () => ({ improve_page: 1.3 }),
    classifyImpactEvidence: (delta) => verdicts[delta.clicks] || { verdict: 'impact-inconclusive', reason: 'within-noise' },
  };
  return { calls, deps };
}
const row = (over = {}) => ({
  gap_id: 1, topic: 'teeth whitening cost', opportunity_type: 'improve_page',
  delta: { clicks: 40 }, before_window: { clicks: 100 }, measured_at: new Date(), ...over,
});

describe('learnFromCompetitorOutcomes', () => {
  test('it reconciles the lifecycle first, so a newly verified outcome is seen in the same run', async () => {
    const h = harness();
    const out = await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.equal(h.calls.reconciled, 1);
    assert.deepEqual(out.advanced, [{ gapId: 1, from: 'drafted', to: 'verified' }]);
  });

  test('a supported improvement is counted as positive', async () => {
    const h = harness({ pending: [row()], verdicts: { 40: { verdict: 'impact-positive', reason: 'supported' } } });
    const out = await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.deepEqual(h.calls.recorded, [{ type: 'improve_page', outcome: 'positive' }]);
    assert.equal(out.counted[0].clicksDelta, 40);
  });

  test('a supported decline is counted as negative, not quietly dropped', async () => {
    const h = harness({ pending: [row({ delta: { clicks: -60 } })], verdicts: { '-60': { verdict: 'impact-negative', reason: 'supported' } } });
    await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.deepEqual(h.calls.recorded, [{ type: 'improve_page', outcome: 'negative' }]);
  });

  test('a change the evidence cannot support is neutral, never a win', async () => {
    const h = harness({ pending: [row({ delta: { clicks: 3 } })] });
    const out = await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.deepEqual(h.calls.recorded, [{ type: 'improve_page', outcome: 'neutral' }]);
    assert.equal(out.counted[0].reason, 'within-noise');
  });

  test('a page that merely moved with the whole site is neutral', async () => {
    const h = harness({ pending: [row({ delta: { clicks: 500 } })], verdicts: { 500: { verdict: 'impact-inconclusive', reason: 'moved-with-site' } } });
    await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.deepEqual(h.calls.recorded, [{ type: 'improve_page', outcome: 'neutral' }]);
  });

  test('an outcome with no usable measurement is skipped entirely, not recorded as neutral', async () => {
    for (const bad of [{ delta: null }, { before_window: null }, { before_window: { impressions: 5 } }]) {
      const h = harness({ pending: [row(bad)] });
      const out = await learnFromCompetitorOutcomes(1, { deps: h.deps });
      assert.deepEqual(h.calls.recorded, [], JSON.stringify(bad));
      assert.equal(out.skipped[0].reason, 'no_measurement');
      assert.deepEqual(h.calls.marked, []);
    }
  });

  test('a before window stored as JSON text is still understood', async () => {
    const h = harness({ pending: [row({ before_window: '{"clicks":100}' })], verdicts: { 40: { verdict: 'impact-positive', reason: 'supported' } } });
    await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.deepEqual(h.calls.recorded, [{ type: 'improve_page', outcome: 'positive' }]);
  });

  test('the same outcome is never counted twice', async () => {
    const h = harness({ pending: [row()], verdicts: { 40: { verdict: 'impact-positive', reason: 'supported' } }, claimed: false });
    const out = await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.deepEqual(h.calls.recorded, []);
    assert.equal(out.skipped[0].reason, 'already_counted');
  });

  test('it claims the outcome before recording it, so a failure cannot double-count', async () => {
    const order = [];
    const h = harness({ pending: [row()], verdicts: { 40: { verdict: 'impact-positive', reason: 'supported' } } });
    h.deps.markOutcomeCounted = async () => { order.push('mark'); return true; };
    h.deps.recordOpportunityOutcome = async () => { order.push('record'); };
    await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.deepEqual(order, ['mark', 'record']);
  });

  test('several outcomes of different kinds are each attributed to their own kind of work', async () => {
    const h = harness({
      pending: [row(), row({ gap_id: 2, opportunity_type: 'new_page', delta: { clicks: -60 } })],
      verdicts: { 40: { verdict: 'impact-positive', reason: 'supported' }, '-60': { verdict: 'impact-negative', reason: 'supported' } },
    });
    await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.deepEqual(h.calls.recorded, [
      { type: 'improve_page', outcome: 'positive' },
      { type: 'new_page', outcome: 'negative' },
    ]);
  });

  test('nothing pending is a clean no-op that still reports what is known', async () => {
    const h = harness();
    const out = await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.deepEqual(out.counted, []);
    assert.deepEqual(out.multipliers, { improve_page: 1.3 });
  });
});

describe('describeLearning', () => {
  test('it says plainly when nothing has been learned yet', () => {
    assert.match(describeLearning({}), /No verified outcomes yet/);
    assert.match(describeLearning(null), /Nothing has been learned/);
  });

  test('it reports what works and what does not, strongest first', () => {
    const text = describeLearning({ new_page: 0.7, improve_page: 1.3, missing: 1.0 });
    assert.match(text, /improve page: has been working here/);
    assert.match(text, /new page: has not been working here/);
    assert.match(text, /missing: is about even here/);
    assert.ok(text.indexOf('improve page') < text.indexOf('new page'));
  });
});

describe('the stored verdict is the one that counts', () => {
  test('a verdict stored by fix-impact is used as-is, because only it had the site control', async () => {
    const h = harness({ pending: [row({ delta: { clicks: 45, verdict: 'impact-positive', verdictReason: 'supported' } })] });
    // The injected classifier would say inconclusive; the stored verdict must win.
    const out = await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.deepEqual(h.calls.recorded, [{ type: 'improve_page', outcome: 'positive' }]);
    assert.equal(out.counted[0].reason, 'supported');
  });

  test('a stored negative verdict is honoured too', async () => {
    const h = harness({ pending: [row({ delta: { clicks: -45, verdict: 'impact-negative', verdictReason: 'supported' } })] });
    await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.deepEqual(h.calls.recorded, [{ type: 'improve_page', outcome: 'negative' }]);
  });

  test('a stored inconclusive verdict stays neutral', async () => {
    const h = harness({ pending: [row({ delta: { clicks: 400, verdict: 'impact-inconclusive', verdictReason: 'moved-with-site' } })] });
    const out = await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.deepEqual(h.calls.recorded, [{ type: 'improve_page', outcome: 'neutral' }]);
    assert.equal(out.counted[0].reason, 'moved-with-site');
  });

  test('a legacy row with no stored verdict is still judged, never assumed', async () => {
    const h = harness({ pending: [row({ delta: { clicks: 40 } })], verdicts: { 40: { verdict: 'impact-positive', reason: 'supported' } } });
    await learnFromCompetitorOutcomes(1, { deps: h.deps });
    assert.deepEqual(h.calls.recorded, [{ type: 'improve_page', outcome: 'positive' }]);
  });
});
