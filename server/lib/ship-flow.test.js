import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shipStep, mergeStagePr, stageBranchOf } from './ship-flow.js';

const stageSite = { repo_default_branch: 'main', pr_target_branch: 'stage' };
const mainSite = { repo_default_branch: 'main', pr_target_branch: null };
const d = (status, o = {}) => ({ id: 1, status, pr_number: null, pr_url: null, pr_base_branch: null, ...o });

describe('which step the card is on', () => {
  test('a site with a stage branch is detected; one without is not', () => {
    assert.equal(stageBranchOf(stageSite), 'stage');
    assert.equal(stageBranchOf(mainSite), null);
    assert.equal(stageBranchOf({ repo_default_branch: 'main', pr_target_branch: 'main' }), null);
  });
  test('nothing in flight means no card', () => assert.equal(shipStep({ drafts: [d('draft'), d('implemented')], site: stageSite }).step, null));
  test('everything decided and some approved: offer to commit and push, not yet a PR', () => {
    assert.deepEqual(shipStep({ drafts: [d('approved'), d('approved'), d('implemented')], site: stageSite }), { step: 'push_branch', count: 2, hasStage: true });
  });
  test('it does not ask while the client still has drafts waiting', () => {
    assert.equal(shipStep({ drafts: [d('approved'), d('submitted_for_approval')], site: stageSite }).step, null);
    assert.equal(shipStep({ drafts: [d('approved'), d('draft')], site: stageSite }).step, null);
  });
  test('the commit is on the branch: offer to open the PR', () => assert.deepEqual(shipStep({ drafts: [d('branch_pushed'), d('branch_pushed')], site: stageSite }), { step: 'open_pr', count: 2, hasStage: true }));
  test('a PR to stage is open: offer to merge it', () => {
    const r = shipStep({ drafts: [d('pr_opened', { pr_number: 244, pr_base_branch: 'stage', pr_url: 'u' })], site: stageSite });
    assert.deepEqual([r.step, r.prNumber], ['merge_stage', 244]);
  });
  test('merged to stage, no PR to main yet: offer to open it', () => {
    assert.equal(shipStep({ drafts: [d('merged_to_stage')], site: stageSite }).step, 'open_main');
    // the way a merged stage PR really looks: still pr_opened, with GitHub saying merged
    assert.equal(shipStep({ drafts: [d('pr_opened', { pr_base_branch: 'stage', pr_state: 'merged', pr_number: 244 })], site: stageSite }).step, 'open_main');
  });
  test('a PR to main is open: waiting for a person (never a merge button)', () => {
    const r = shipStep({ drafts: [d('merged_to_stage')], site: stageSite, promotions: [{ status: 'opened', promotion_pr_number: 245, promotion_pr_url: 'u2' }] });
    assert.deepEqual([r.step, r.prNumber], ['waiting', 245]);
  });
  test('a site with no stage: its open PR goes to main and waits for a person, with no merge step', () => {
    const r = shipStep({ drafts: [d('pr_opened', { pr_number: 9, pr_base_branch: 'main' })], site: mainSite });
    assert.deepEqual([r.step, r.hasStage], ['waiting', false]);
  });
  test('a new approval is never hidden behind an older PR: push comes first', () => {
    assert.equal(shipStep({ drafts: [d('approved'), d('pr_opened', { pr_base_branch: 'stage', pr_number: 1 })], site: stageSite }).step, 'push_branch');
  });
});

describe('merging into stage is guarded', () => {
  const pr = (o = {}) => ({ state: 'open', merged: false, mergeable: true, base: 'stage', headSha: 'abc', ...o });
  const ok = (o = {}) => ({ getPr: async () => pr(o.pr), getChecks: async () => o.checks || [{ name: 'build', status: 'completed', conclusion: 'success' }], merge: async () => { o.calls?.push('merge'); return { merged: true, sha: 'def' }; } });
  const forbidden = async () => { throw new Error('must not reach GitHub'); };

  test('a person asks, on stage, with green checks: it merges', async () => {
    const calls = [];
    const r = await mergeStagePr(stageSite, 244, { userId: 5 }, ok({ calls }));
    assert.deepEqual([r.ok, r.sha, r.base], [true, 'def', 'stage']);
    assert.deepEqual(calls, ['merge']);
  });
  test('nobody signed in: refused before GitHub is touched', async () => {
    const r = await mergeStagePr(stageSite, 244, {}, { getPr: forbidden, getChecks: forbidden, merge: forbidden });
    assert.equal(r.reason, 'no-person');
  });
  test('a site with no stage branch is never merged from here', async () => {
    const r = await mergeStagePr(mainSite, 9, { userId: 5 }, { getPr: forbidden, getChecks: forbidden, merge: forbidden });
    assert.equal(r.reason, 'no-stage');
  });
  test('a PR that targets main is refused even if everything else is fine', async () => {
    const calls = [];
    const r = await mergeStagePr(stageSite, 245, { userId: 5 }, ok({ pr: { base: 'main' }, calls }));
    assert.equal(r.reason, 'not-stage');
    assert.deepEqual(calls, []);
  });
  test('GitHub being unreachable is reported as that, not as a closed PR, and nothing is merged', async () => {
    const calls = [];
    const r = await mergeStagePr(stageSite, 1, { userId: 5 }, { getPr: async () => { throw new Error('ECONNREFUSED'); }, getChecks: forbidden, merge: async () => { calls.push('merge'); } });
    assert.equal(r.reason, 'github-error');
    assert.deepEqual(calls, []);
  });
  test('closed or already merged PRs are refused', async () => {
    assert.equal((await mergeStagePr(stageSite, 1, { userId: 5 }, ok({ pr: { state: 'closed' } }))).reason, 'not-open');
    assert.equal((await mergeStagePr(stageSite, 1, { userId: 5 }, ok({ pr: { merged: true } }))).reason, 'not-open');
  });
  test('running or failed checks stop it', async () => {
    const calls = [];
    assert.equal((await mergeStagePr(stageSite, 1, { userId: 5 }, ok({ checks: [{ status: 'in_progress', conclusion: null }], calls }))).reason, 'checks-pending');
    assert.equal((await mergeStagePr(stageSite, 1, { userId: 5 }, ok({ checks: [{ status: 'completed', conclusion: 'failure' }], calls }))).reason, 'checks-failed');
    assert.deepEqual(calls, []);
  });
  test('a PR GitHub says conflicts is not merged', async () => {
    assert.equal((await mergeStagePr(stageSite, 1, { userId: 5 }, ok({ pr: { mergeable: false } }))).reason, 'conflicts');
  });
  test('a repository with no checks at all is allowed to merge', async () => {
    assert.equal((await mergeStagePr(stageSite, 1, { userId: 5 }, ok({ checks: [] }))).ok, true);
  });
  test('GitHub declining the merge is reported, not hidden', async () => {
    const r = await mergeStagePr(stageSite, 1, { userId: 5 }, { ...ok(), merge: async () => ({ merged: false }) });
    assert.equal(r.reason, 'not-merged');
  });
});
