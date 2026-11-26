import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sweepAnalystOutcomes, isTransientPushFailure } from './analyst-outcome.js';

// A row as getAnalystOutcomeChain returns it once fix-impact.js has measured the fix.
const row = (id, over = {}) => ({
  id, recommendation_type: 'expand-content', impact_status: 'measured', delta: { clicks: 12, impressions: 300 },
  impact_measured_at: '2026-11-20T00:00:00Z', draft_id: id * 10, pr_url: `https://example/pr/${id}`, recommendation_status: 'done', ...over,
});

function harness(rows, { push } = {}) {
  const recorded = []; const pushed = [];
  return {
    recorded, pushed,
    deps: {
      getChain: async () => rows,
      record: async (id, outcome) => { recorded.push({ id, outcome }); },
      push: push || (async (siteId, body) => { pushed.push({ siteId, body }); return {}; }),
    },
  };
}

describe('sweepAnalystOutcomes feeds measured results back to the Data Analyst', () => {
  test('a measured fix is sent to its own project with a stable reference, then recorded locally', async () => {
    const h = harness([row(5)]);
    const r = await sweepAnalystOutcomes(42, h.deps);
    assert.deepEqual(h.pushed.map((p) => p.siteId), [42]);
    assert.deepEqual(h.pushed[0].body, {
      external_ref: 'analyst_evidence:5', generator_id: 'expand-content', improved: true, clicks_delta: 12,
      delta: { clicks: 12, impressions: 300 }, measured_at: '2026-11-20T00:00:00Z',
    });
    assert.equal(h.recorded.length, 1);
    assert.deepEqual({ recorded: r.recorded, sent: r.sent, deferred: r.deferred }, { recorded: 1, sent: 1, deferred: 0 });
  });

  test('a fix that made clicks WORSE is sent as not improved (a miss is evidence too)', async () => {
    const h = harness([row(6, { delta: { clicks: -4 } })]);
    await sweepAnalystOutcomes(1, h.deps);
    assert.equal(h.pushed[0].body.improved, false);
  });

  test('a fix still inside its measurement window is neither sent nor recorded', async () => {
    const h = harness([row(7, { impact_status: 'pending', delta: null })]);
    const r = await sweepAnalystOutcomes(1, h.deps);
    assert.equal(h.pushed.length + h.recorded.length, 0);
    assert.equal(r.recorded, 0);
  });

  test('an analyst that is unreachable (or 5xx) leaves the outcome UNMEASURED so the next sweep retries it: nothing is lost', async () => {
    for (const err of [Object.assign(new Error('unreachable'), { status: 502 }), Object.assign(new Error('boom'), { status: 500 }), new Error('no status')]) {
      const h = harness([row(8)], { push: async () => { throw err; } });
      const r = await sweepAnalystOutcomes(1, h.deps);
      assert.equal(h.recorded.length, 0, `${err.message}: must stay unmeasured`);
      assert.equal(r.deferred, 1);
    }
  });

  test('a permanent rejection (the analyst does not know this project) does not block the local record forever', async () => {
    const h = harness([row(9)], { push: async () => { throw Object.assign(new Error('Client not found.'), { status: 404 }); } });
    const r = await sweepAnalystOutcomes(1, h.deps);
    assert.equal(h.recorded.length, 1);
    assert.equal(r.sent, 0);
  });

  test('one failing row never stops the others', async () => {
    let n = 0;
    const h = harness([row(10), row(11), row(12)], { push: async () => { if (++n === 2) throw Object.assign(new Error('down'), { status: 503 }); } });
    const r = await sweepAnalystOutcomes(1, h.deps);
    assert.deepEqual(h.recorded.map((x) => x.id), [10, 12]);
    assert.equal(r.deferred, 1);
  });

  test('an outcome with no readable direction is recorded but never sent: it says nothing about a prediction', async () => {
    const h = harness([row(13, { delta: { clicks: null } })]);
    await sweepAnalystOutcomes(1, h.deps);
    assert.equal(h.pushed.length, 0);
    assert.equal(h.recorded.length, 1);
  });

  test('isTransientPushFailure: only a 4xx is permanent', () => {
    assert.equal(isTransientPushFailure({ status: 404 }), false);
    assert.equal(isTransientPushFailure({ status: 422 }), false);
    assert.equal(isTransientPushFailure({ status: 502 }), true);
    assert.equal(isTransientPushFailure(new Error('x')), true);
  });
});
