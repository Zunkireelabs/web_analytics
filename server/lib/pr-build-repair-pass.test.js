import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { repairOpenBatchPrBuilds, buildRepairMode } from './pr-build-repair-pass.js';

const SITE = { id: 8871, repo_owner: 'o', repo_name: 'r' };
const mk = ({ rows = [{ pr_number: 15 }, { pr_number: 14 }], outcomes = {}, site = SITE } = {}) => {
  const calls = { repair: [], queries: [] };
  return { calls, deps: {
    getSiteById: async () => site,
    query: async (sql, params) => { calls.queries.push({ sql, params }); return { rows }; },
    repairFailingBatchPr: async (_s, n, { apply }) => { calls.repair.push({ n, apply }); const o = outcomes[n]; if (o instanceof Error) throw o; return o || { outcome: 'green' }; },
  } };
};

describe('buildRepairMode', () => {
  test('defaults to log; accepts off, log, on; anything else is log', () => {
    assert.equal(buildRepairMode({}), 'log');
    for (const m of ['off', 'log', 'on']) assert.equal(buildRepairMode({ PR_BUILD_REPAIR: m }), m);
    assert.equal(buildRepairMode({ PR_BUILD_REPAIR: 'ON' }), 'on');
    assert.equal(buildRepairMode({ PR_BUILD_REPAIR: 'yes please' }), 'log');
  });
});

describe('repairOpenBatchPrBuilds', () => {
  test('off: does nothing at all, not even a query', async () => {
    const m = mk();
    const r = await repairOpenBatchPrBuilds(8871, { mode: 'off', deps: m.deps });
    assert.equal(r.checked, 0);
    assert.equal(m.calls.queries.length, 0);
  });
  test('log (the default): reads each open agent PR and never asks for a write', async () => {
    const m = mk();
    const logs = [];
    await repairOpenBatchPrBuilds(8871, { mode: 'log', log: (l) => logs.push(l), deps: m.deps });
    assert.deepEqual(m.calls.repair, [{ n: 15, apply: false }, { n: 14, apply: false }]);
  });
  test('on: asks for the write', async () => {
    const m = mk({ rows: [{ pr_number: 15 }] });
    await repairOpenBatchPrBuilds(8871, { mode: 'on', deps: m.deps });
    assert.deepEqual(m.calls.repair, [{ n: 15, apply: true }]);
  });
  test('only open PRs on the agent\'s own branches are looked at', async () => {
    const m = mk();
    await repairOpenBatchPrBuilds(8871, { mode: 'log', deps: m.deps });
    assert.match(m.calls.queries[0].sql, /pr_state, 'open'\) = 'open'/);
    assert.deepEqual(m.calls.queries[0].params, [8871, 'action-center/batch-%']);
  });
  test('a repaired PR and a held PR are counted, and a red PR it could not plan for is reported', async () => {
    const m = mk({ rows: [{ pr_number: 1 }, { pr_number: 2 }, { pr_number: 3 }, { pr_number: 4 }], outcomes: {
      1: { outcome: 'repaired', failure: { kind: 'duplicate-front-matter-key' }, plan: { actions: [{ op: 'rewrite', path: 'a.md' }] } },
      2: { outcome: 'held', failure: { kind: 'content-schema' }, plan: { actions: [{ op: 'delete', path: 'b.md' }] } },
      3: { outcome: 'unknown', reason: 'not recognised' },
      4: { outcome: 'green' },
    } });
    const logs = [];
    const r = await repairOpenBatchPrBuilds(8871, { mode: 'on', log: (l) => logs.push(l), deps: m.deps });
    assert.deepEqual([r.checked, r.repaired, r.held, r.red], [4, 1, 1, 1]);
    assert.equal(logs.length, 3);
  });
  test('one PR that cannot be read does not stop the others', async () => {
    const m = mk({ rows: [{ pr_number: 1 }, { pr_number: 2 }], outcomes: { 1: new Error('GitHub 502') } });
    const logs = [];
    const r = await repairOpenBatchPrBuilds(8871, { mode: 'log', log: (l) => logs.push(l), deps: m.deps });
    assert.equal(r.checked, 2);
    assert.match(logs[0], /could not be checked/);
  });
  test('a site with no repository is skipped', async () => {
    const m = mk({ site: { id: 8873 } });
    assert.equal((await repairOpenBatchPrBuilds(8873, { mode: 'on', deps: m.deps })).checked, 0);
  });
});
