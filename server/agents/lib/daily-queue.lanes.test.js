import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyQueue } from './daily-queue.js';

// The two-lane capacity model: an ANALYTICS lane for routine remediation and
// a reserved ANALYST lane for forward-looking growth/prevention work, counted
// separately and capped together at 120.
//
// The lane matters because the analytics backlog is effectively unbounded
// (236 eligible expand-content items on the reference site), so without a
// reservation open merit hands every slot to routine work and the preventive
// items — the whole reason the day was extended — never ship.

function rec(id, { type = 'meta-title', page = null } = {}) {
  return { id, recommendation_type: type, finding_ids: [`f${id}`], page, params: page ? { page } : {}, expected_impact: {} };
}
// A page in `declines` marks its recommendation as analyst-lane work.
const declining = (page) => [page, { page, reasons: ['position slipped'], impressionsLost: 500, impressionsAtRisk: 0, declineScore: 500 }];

function build({ analytics = 0, analyst = 0, remaining, analystBudget, baselineBudget }) {
  const candidates = [];
  const declines = new Map();
  for (let i = 0; i < analytics; i++) candidates.push(rec(1000 + i, { type: 'expand-content', page: `/routine-${i}` }));
  for (let i = 0; i < analyst; i++) {
    const page = `/declining-${i}`;
    candidates.push(rec(2000 + i, { type: 'meta-title', page }));
    declines.set(...declining(page));
  }
  return buildDailyQueue({ candidates, remaining, declines, analystBudget, baselineBudget });
}
const laneCounts = (queue) => ({
  analyst: queue.filter((i) => i.lane === 'analyst').length,
  analytics: queue.filter((i) => i.lane === 'analytics').length,
});

describe('two-lane daily capacity', () => {
  test('a full day is 100 analytics + 20 analyst = 120, never more', () => {
    const { queue } = build({ analytics: 300, analyst: 50, remaining: 120, analystBudget: 20, baselineBudget: 100 });
    assert.deepEqual(laneCounts(queue), { analytics: 100, analyst: 20 });
    assert.equal(queue.length, 120);
  });

  test('60 analytics + 20 analyst = 80', () => {
    const { queue } = build({ analytics: 300, analyst: 50, remaining: 80, analystBudget: 20, baselineBudget: 60 });
    assert.deepEqual(laneCounts(queue), { analytics: 60, analyst: 20 });
  });

  test('40 valid analytics findings ship all 40, never padded to the target', () => {
    const { queue } = build({ analytics: 40, analyst: 50, remaining: 60, analystBudget: 20, baselineBudget: 40 });
    assert.deepEqual(laneCounts(queue), { analytics: 40, analyst: 20 });
    assert.equal(queue.length, 60);
  });

  test('10 analytics + 15 analyst = 25 — both lanes follow the real work', () => {
    const { queue } = build({ analytics: 10, analyst: 15, remaining: 25, analystBudget: 15, baselineBudget: 10 });
    assert.deepEqual(laneCounts(queue), { analytics: 10, analyst: 15 });
  });

  test('zero analytics findings still ships 12 strong analyst opportunities', () => {
    const { queue } = build({ analytics: 0, analyst: 12, remaining: 12, analystBudget: 12, baselineBudget: 0 });
    assert.deepEqual(laneCounts(queue), { analytics: 0, analyst: 12 });
  });

  test('an unfilled analyst lane does NOT leak its slots to routine backlog', () => {
    // 3 evidenced analyst items against a 20-slot lane: the day shrinks to
    // 60 + 3, it does not backfill 17 more expand-content items.
    const { queue } = build({ analytics: 300, analyst: 3, remaining: 63, analystBudget: 3, baselineBudget: 60 });
    assert.deepEqual(laneCounts(queue), { analytics: 60, analyst: 3 });
    assert.equal(queue.length, 63, 'ships 43-style composition: all analytics + only the evidenced analyst work');
  });

  test('a huge analytics backlog cannot squeeze out the analyst lane at the ceiling', () => {
    const { queue } = build({ analytics: 500, analyst: 20, remaining: 120, analystBudget: 20, baselineBudget: 100 });
    assert.equal(laneCounts(queue).analyst, 20, 'the reserved lane survives an unbounded backlog');
  });

  test('with no analyst budget the day is a pure analytics day', () => {
    const { queue } = build({ analytics: 300, analyst: 0, remaining: 100, analystBudget: 0, baselineBudget: 100 });
    assert.deepEqual(laneCounts(queue), { analytics: 100, analyst: 0 });
  });
});
