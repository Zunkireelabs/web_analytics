import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePlatformRepairToStage, sweepPlatformRepairPrs, stagingAutomergeEnabled } from './platform-staging-merge.js';

const ENV = { ENABLE_PLATFORM_STAGING_AUTOMERGE: 'true' };
const PR = { state: 'open', merged: false, mergeable: true, base: 'stage', headRef: 'fix/self-repair-direct-answer-x', headSha: 'abc123' };
const GREEN = [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }];

function deps(over = {}) {
  const calls = { merged: [] };
  return {
    calls,
    deps: {
      env: ENV, getPr: async () => PR, getChecks: async () => GREEN,
      merge: async (repo, n, opts) => { calls.merged.push([n, opts]); return { merged: true, sha: 'def456' }; }, ...over,
    },
  };
}

test('OFF by default: nothing is merged unless the staging agent is switched on', async () => {
  assert.equal(stagingAutomergeEnabled({}), false);
  const d = deps({ env: {} });
  const r = await mergePlatformRepairToStage(7, d.deps);
  assert.equal(r.reason, 'disabled');
  assert.equal(d.calls.merged.length, 0);
});

test('a validated self-repair PR into stage with every check green is merged, pinned to the exact reviewed commit', async () => {
  const d = deps();
  const r = await mergePlatformRepairToStage(7, d.deps);
  assert.equal(r.ok, true);
  assert.equal(r.base, 'stage');
  assert.deepEqual(d.calls.merged, [[7, { sha: 'abc123' }]]);
});

test('NEVER merges a PR into main — even a self-repair PR with green checks', async () => {
  const d = deps({ getPr: async () => ({ ...PR, base: 'main' }) });
  const r = await mergePlatformRepairToStage(7, d.deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-stage');
  assert.equal(d.calls.merged.length, 0);
});

test('NEVER merges when stage is configured as the production branch (misconfiguration fails closed)', async () => {
  const d = deps({ env: { ...ENV, PLATFORM_REPO_BASE_BRANCH: 'main' }, getPr: async () => ({ ...PR, base: 'main' }) });
  const r = await mergePlatformRepairToStage(7, d.deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsafe-base-branch');
  assert.equal(d.calls.merged.length, 0);
});

test('only self-repair branches: a human or feature PR into stage is left alone', async () => {
  const d = deps({ getPr: async () => ({ ...PR, headRef: 'feature/SRANK-9-thing' }) });
  assert.equal((await mergePlatformRepairToStage(7, d.deps)).reason, 'not-a-repair-branch');
  assert.equal(d.calls.merged.length, 0);
});

test('closed or already-merged PRs are not touched', async () => {
  for (const pr of [{ ...PR, state: 'closed' }, { ...PR, merged: true }]) {
    assert.equal((await mergePlatformRepairToStage(7, deps({ getPr: async () => pr }).deps)).reason, 'not-open');
  }
});

test('conflicts are not merged', async () => {
  assert.equal((await mergePlatformRepairToStage(7, deps({ getPr: async () => ({ ...PR, mergeable: false }) }).deps)).reason, 'conflicts');
});

test('FAIL CLOSED on the checks: none visible, pending, failed or unreadable all mean "do not merge"', async () => {
  const cases = [
    [[], 'no-checks'],
    [[{ status: 'in_progress', conclusion: null }], 'checks-pending'],
    [[{ status: 'completed', conclusion: 'failure' }], 'checks-failed'],
    [[{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'cancelled' }], 'checks-failed'],
  ];
  for (const [checks, reason] of cases) {
    const d = deps({ getChecks: async () => checks });
    assert.equal((await mergePlatformRepairToStage(7, d.deps)).reason, reason);
    assert.equal(d.calls.merged.length, 0);
  }
  const unreadable = deps({ getChecks: async () => { throw new Error('boom'); } });
  assert.equal((await mergePlatformRepairToStage(7, unreadable.deps)).reason, 'checks-pending');
  assert.equal(unreadable.calls.merged.length, 0);
});

test('GitHub errors are reported, never thrown, never treated as success', async () => {
  assert.equal((await mergePlatformRepairToStage(7, deps({ getPr: async () => { throw new Error('x'); } }).deps)).reason, 'github-error');
  assert.equal((await mergePlatformRepairToStage(7, deps({ merge: async () => { throw new Error('x'); } }).deps)).reason, 'github-error');
  assert.equal((await mergePlatformRepairToStage(7, deps({ merge: async () => ({ merged: false }) }).deps)).reason, 'not-merged');
});

test('the sweep merges ready repair PRs, skips everything else, and never throws into the scheduler', async () => {
  const merged = [];
  const prs = [
    { number: 1, base: 'stage', headRef: 'fix/self-repair-a', headSha: 's1' },
    { number: 2, base: 'stage', headRef: 'feature/SRANK-3-x', headSha: 's2' },
    { number: 3, base: 'stage', headRef: 'fix/self-repair-b', headSha: 's3' },
  ];
  const r = await sweepPlatformRepairPrs({
    env: ENV, listOpen: async () => prs,
    getPr: async (_r, n) => ({ ...PR, headRef: prs.find((p) => p.number === n).headRef, headSha: prs.find((p) => p.number === n).headSha }),
    getChecks: async (_r, sha) => (sha === 's3' ? [{ status: 'completed', conclusion: 'failure' }] : GREEN),
    merge: async (_r, n) => { merged.push(n); return { merged: true, sha: 'z' }; },
  });
  assert.equal(r.ran, true);
  assert.deepEqual(merged, [1]);
  assert.deepEqual(r.results.map((x) => [x.prNumber, x.ok ?? false, x.reason ?? null]), [[1, true, null], [3, false, 'checks-failed']]);
});

test('the sweep does nothing when disabled, when stage is unsafe, or when GitHub cannot be listed', async () => {
  assert.equal((await sweepPlatformRepairPrs({ env: {} })).reason, 'disabled');
  assert.equal((await sweepPlatformRepairPrs({ env: { ...ENV, PLATFORM_REPO_BASE_BRANCH: 'main' } })).reason, 'unsafe-base-branch');
  assert.equal((await sweepPlatformRepairPrs({ env: ENV, listOpen: async () => { throw new Error('x'); } })).reason, 'github-error');
});
