import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { orderAgentsForSidebar, agentState } from './sidebar-agents.js';

const a = (id, lastRunStatus, lastRunAt) => ({ id, name: id, lastRunStatus, lastRunAt });

describe('sidebar agent list', () => {
  test('running comes only from the live map, never from an old run', () => {
    assert.equal(agentState(a('x', 'ok', '2026-11-01'), new Map()), 'done');
    assert.equal(agentState(a('x', 'ok', '2026-11-01'), new Map([['x', 1]])), 'running');
    assert.equal(agentState(a('x', null, null), new Map()), 'idle');
    assert.equal(agentState(a('x', 'error', '2026-11-01'), new Map()), 'failed');
  });
  test('order: running, failed, most recent done, never run', () => {
    const rows = orderAgentsForSidebar([
      a('never', null, null), a('old', 'ok', '2026-10-01'), a('new', 'ok', '2026-11-19'), a('bad', 'error', '2026-11-18'), a('live', 'ok', '2026-11-01'),
    ], new Map([['live', 5]]));
    assert.deepEqual(rows.map((r) => r.id), ['live', 'bad', 'new', 'old', 'never']);
  });
  test('the longest-running agent is first among those running', () => {
    const rows = orderAgentsForSidebar([a('b', 'ok', null), a('a', 'ok', null)], new Map([['b', 20], ['a', 10]]));
    assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);
  });
  test('null agents (still loading) is an empty list', () => assert.deepEqual(orderAgentsForSidebar(null, new Map()), []));
});
