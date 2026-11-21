import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRepairBase, checkAutoMergeTarget, platformBranches, SELF_REPAIR_BRANCH_PREFIX } from './platform-branch-policy.js';

test('default: repairs go to "stage", production is "main"', () => {
  assert.deepEqual(platformBranches({}), { stage: 'stage', production: 'main' });
  assert.deepEqual(checkRepairBase({}), { ok: true, stage: 'stage', production: 'main' });
});

test('FAIL CLOSED: a stage branch that IS the production branch gives no target at all', () => {
  const r = checkRepairBase({ PLATFORM_REPO_BASE_BRANCH: 'main' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsafe-base-branch');
});

test('FAIL CLOSED: production-sounding names are refused whatever the configured production branch is', () => {
  for (const name of ['main', 'master', 'production', 'prod', 'release', 'live', 'MAIN', 'Production']) {
    assert.equal(checkRepairBase({ PLATFORM_REPO_BASE_BRANCH: name, PLATFORM_PRODUCTION_BRANCH: 'trunk' }).ok, false, name);
  }
});

test('stage equal to a custom production branch is refused', () => {
  assert.equal(checkRepairBase({ PLATFORM_REPO_BASE_BRANCH: 'trunk', PLATFORM_PRODUCTION_BRANCH: 'trunk' }).ok, false);
});

test('unset falls back to the SAFE default "stage"; a blank-but-set value is "no stage configured", never main', () => {
  assert.equal(platformBranches({ PLATFORM_REPO_BASE_BRANCH: '' }).stage, 'stage');
  const blank = checkRepairBase({ PLATFORM_REPO_BASE_BRANCH: '   ' });
  assert.equal(blank.ok, false);
  assert.equal(blank.reason, 'no-stage-configured');
});

test('auto-merge: only a self-repair branch into stage', () => {
  assert.equal(checkAutoMergeTarget({ base: 'stage', headRef: `${SELF_REPAIR_BRANCH_PREFIX}direct-answer-x` }, {}).ok, true);
});

test('auto-merge REFUSES main — the one rule that cannot fail', () => {
  const r = checkAutoMergeTarget({ base: 'main', headRef: `${SELF_REPAIR_BRANCH_PREFIX}x` }, {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-stage');
});

test('auto-merge refuses any branch that is not a self-repair branch', () => {
  for (const headRef of ['feature/SRANK-1-x', 'fix/something', 'stage', null, '']) {
    assert.equal(checkAutoMergeTarget({ base: 'stage', headRef }, {}).reason, 'not-a-repair-branch', String(headRef));
  }
});

test('auto-merge is refused outright when stage itself is unsafe, even for a matching PR', () => {
  const env = { PLATFORM_REPO_BASE_BRANCH: 'main' };
  assert.equal(checkAutoMergeTarget({ base: 'main', headRef: `${SELF_REPAIR_BRANCH_PREFIX}x` }, env).ok, false);
});
