import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isApprovalText, approversOf, handleApprovalSignal } from './approval-merge.js';
import { mergeStagePr } from './ship-flow.js';

const site = { id: 5, ship_mode: 'auto', pr_target_branch: 'stage', repo_default_branch: 'main', url_file_map: { approvers: ['Client-Jane'] } };
const openPr = { state: 'open', merged: false, base: 'stage', mergeable: true, headSha: 'abc' };
function deps(over = {}) {
  const log = { merged: [], comments: [], promoted: 0, synced: 0 };
  return { log, d: {
    readPr: async () => openPr,
    merge: async (s, n, o) => { log.merged.push({ n, o }); return { ok: true, base: 'stage', sha: 's1' }; },
    comment: async (_s, _n, body) => { log.comments.push(body); },
    syncDrafts: async () => { log.synced++; },
    promote: async () => { log.promoted++; return { opened: { number: 9 } }; },
    ...over,
  } };
}

describe('isApprovalText', () => {
  test('plain approvals only', () => {
    for (const t of ['ok', 'OK.', 'Okay!', 'approved', 'LGTM', 'looks good', 'go ahead', 'ship it', '👍', '  yes  ']) assert.equal(isApprovalText(t), true, t);
    for (const t of ['not ok', 'ok but change the title', 'is this ok?', 'please do not merge', '', 'no', 'okay so what about the other pages and the redirect?']) assert.equal(isApprovalText(t), false, t);
  });
});

describe('handleApprovalSignal', () => {
  test('named approver says OK -> merged into stage as a person (not an agent), requireChecks on, drafts synced, promotion PR requested', async () => {
    const { log, d } = deps();
    const r = await handleApprovalSignal(site, 12, { actor: 'client-jane', via: 'github', text: 'ok' }, d);
    assert.equal(r.ok, true);
    assert.equal(log.merged[0].o.userId, 'github:client-jane');
    assert.equal(log.merged[0].o.requireChecks, true);
    assert.equal(log.synced, 1); assert.equal(log.promoted, 1);
    assert.match(log.comments[0], /Merged into `stage`/);
  });
  test('an approving review counts; a non-approving review does not', async () => {
    assert.equal((await handleApprovalSignal(site, 1, { actor: 'client-jane', reviewState: 'APPROVED' }, deps().d)).ok, true);
    assert.equal((await handleApprovalSignal(site, 1, { actor: 'client-jane', reviewState: 'commented' }, deps().d)).reason, 'not-approval');
  });
  test('anyone who is not a named approver is ignored — nothing merged, nothing commented', async () => {
    const { log, d } = deps();
    const r = await handleApprovalSignal(site, 1, { actor: 'stranger', text: 'ok' }, d);
    assert.equal(r.reason, 'not-approver'); assert.equal(log.merged.length, 0); assert.equal(log.comments.length, 0);
    assert.equal((await handleApprovalSignal({ ...site, url_file_map: {} }, 1, { actor: 'client-jane', text: 'ok' }, d)).reason, 'not-approver');
  });
  test('Mobilise-style review-first sites are never merged by a message', async () => {
    const { log, d } = deps();
    const r = await handleApprovalSignal({ ...site, ship_mode: 'review-first' }, 1, { actor: 'client-jane', text: 'ok' }, d);
    assert.equal(r.reason, 'manual-site'); assert.equal(log.merged.length, 0);
  });
  test('a PR that is closed, merged, or not the agent\'s own is never merged', async () => {
    assert.equal((await handleApprovalSignal(site, 1, { actor: 'client-jane', text: 'ok' }, deps({ readPr: async () => ({ ...openPr, merged: true }) }).d)).reason, 'not-open');
    const { log, d } = deps({ isAgentPr: async () => false });
    assert.equal((await handleApprovalSignal(site, 1, { actor: 'client-jane', text: 'ok' }, d)).reason, 'not-agent-pr'); assert.equal(log.merged.length, 0);
  });
  test('a guard refusal (checks failed) leaves it open, says why on the PR, and does not promote', async () => {
    const { log, d } = deps({ merge: async () => ({ ok: false, reason: 'checks-failed', message: 'A check failed, so it was not merged.' }) });
    const r = await handleApprovalSignal(site, 1, { actor: 'client-jane', text: 'ok' }, d);
    assert.equal(r.ok, false); assert.equal(log.promoted, 0); assert.match(log.comments[0], /not merged/);
  });
});

describe('mergeStagePr requireChecks (real guard, fake GitHub)', () => {
  const g = (checks) => ({ getPr: async () => openPr, getChecks: async () => checks, merge: async () => ({ merged: true, sha: 'z' }) });
  test('no checks at all -> refused only when requireChecks is set', async () => {
    assert.equal((await mergeStagePr(site, 1, { userId: 'u', requireChecks: true }, g([]))).reason, 'no-checks');
    assert.equal((await mergeStagePr(site, 1, { userId: 'u' }, g([]))).ok, true);
  });
  test('green checks merge; pending or failed do not; main-targeted PRs never merge', async () => {
    assert.equal((await mergeStagePr(site, 1, { userId: 'u', requireChecks: true }, g([{ status: 'completed', conclusion: 'success' }]))).ok, true);
    assert.equal((await mergeStagePr(site, 1, { userId: 'u', requireChecks: true }, g([{ status: 'in_progress' }]))).reason, 'checks-pending');
    assert.equal((await mergeStagePr(site, 1, { userId: 'u', requireChecks: true }, g([{ status: 'completed', conclusion: 'failure' }]))).reason, 'checks-failed');
    assert.equal((await mergeStagePr(site, 1, { userId: 'u', requireChecks: true }, { ...g([{ status: 'completed', conclusion: 'success' }]), getPr: async () => ({ ...openPr, base: 'main' }) })).reason, 'not-stage');
  });
  test('approversOf normalises', () => { assert.deepEqual(approversOf(site), ['client-jane']); assert.deepEqual(approversOf({}), []); });
});
