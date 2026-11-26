import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFindingsGate, gateForSite, findingsGateEnabled } from './analyst-findings-gate.js';

const NOW = new Date('2026-11-25T10:00:00Z');
const rowQuery = (row) => async () => ({ rows: row ? [row] : [] });
const complete = (over = {}) => ({ status: 'completed', started_at: '2026-11-25T02:00:00Z', finished_at: '2026-11-25T03:00:00Z', detail: { pass_id: 'p1', complete: true, covered_clients: [1, 8864], excluded_clients: { 8871: 'run_predictions: required input not fresh: page_query newest day 2026-10-01 is 55 day(s) old (limit 5)' } }, error: null, ...over });

describe('analyst findings gate', () => {
  test('a recent completed marker lets findings through for a covered site', async () => {
    const gate = await loadFindingsGate({ query: rowQuery(complete()), now: NOW });
    assert.equal(gate.state, 'complete');
    assert.deepEqual(gateForSite(gate, 8864), { allowed: true, reason: null });
  });

  test('a site the analysis did not cover is refused, with the analyst\'s own reason', async () => {
    const gate = await loadFindingsGate({ query: rowQuery(complete()), now: NOW });
    const r = gateForSite(gate, 8871);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /did not cover this project.*page_query newest day/);
  });

  test('a FAILED marker (a run that did not complete) blocks every site and carries the recorded reason', async () => {
    const gate = await loadFindingsGate({ query: rowQuery(complete({ status: 'failed', error: 'findings incomplete: run_insight_engine: failed' })), now: NOW });
    assert.equal(gate.state, 'incomplete');
    assert.equal(gateForSite(gate, 1).allowed, false);
    assert.match(gateForSite(gate, 1).reason, /run_insight_engine: failed/);
  });

  test('no marker at all is not confirmed (the production state since 2026-11-16)', async () => {
    const gate = await loadFindingsGate({ query: rowQuery(null), now: NOW });
    assert.equal(gate.state, 'missing');
    assert.equal(gateForSite(gate, 1).allowed, false);
  });

  test('an old completed marker is stale, not confirmed', async () => {
    const gate = await loadFindingsGate({ query: rowQuery(complete({ finished_at: '2026-11-20T03:00:00Z' })), now: NOW });
    assert.equal(gate.state, 'stale');
    assert.equal(gateForSite(gate, 1).allowed, false);
  });

  test('a marker that cannot be read counts as not confirmed, never as complete', async () => {
    const gate = await loadFindingsGate({ query: async () => { throw new Error('relation "ai_activity_log" does not exist'); }, now: NOW });
    assert.equal(gate.state, 'unreadable');
    assert.equal(gateForSite(gate, 1).allowed, false);
  });

  test('a marker written before coverage was recorded covers everyone, not no one', async () => {
    const gate = await loadFindingsGate({ query: rowQuery(complete({ detail: { pass_id: 'old' } })), now: NOW });
    assert.equal(gate.state, 'complete');
    assert.equal(gateForSite(gate, 12345).allowed, true);
  });

  test('the gate is on unless an operator switches it off', () => {
    assert.equal(findingsGateEnabled({}), true);
    assert.equal(findingsGateEnabled({ ANALYST_REQUIRE_FINDINGS_COMPLETE: 'false' }), false);
    assert.equal(findingsGateEnabled({ ANALYST_REQUIRE_FINDINGS_COMPLETE: 'true' }), true);
  });
});
