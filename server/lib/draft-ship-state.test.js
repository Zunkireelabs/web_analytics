import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { draftShipState, SHIP_STATE } from './draft-ship-state.js';

// The distinction both ship paths were missing: a draft that is FINISHED vs.
// one that is STUCK PART-WAY. auto-remediation.js called every non-submittable
// draft a failure (feeding the circuit breaker); shipRecommendation called
// every one of them "already shipped" (reporting work as landed that never
// reached GitHub). Exactly one of those is right for each status.
describe('draftShipState', () => {
  test('the normal path — a fresh or edited draft is submittable', () => {
    assert.equal(draftShipState({ status: 'draft' }), SHIP_STATE.SUBMITTABLE);
    assert.equal(draftShipState({ status: 'edited' }), SHIP_STATE.SUBMITTABLE);
  });

  test('a merged or PR-opened draft is genuinely finished — nothing to redo', () => {
    assert.equal(draftShipState({ status: 'implemented' }), SHIP_STATE.SHIPPED);
    assert.equal(draftShipState({ status: 'pr_opened' }), SHIP_STATE.SHIPPED);
  });

  // The live case: 8 expand-content drafts on site 1 sat here since
  // 2026-08-28. The push failed, nothing ever re-ran it, and every run
  // re-picked the finding only to reach the same dead end.
  test("a draft stranded at 'approved' needs its apply re-run, not a regeneration", () => {
    assert.equal(draftShipState({ status: 'approved' }), SHIP_STATE.RESUME_APPLY);
    assert.equal(
      draftShipState({ status: 'approved', apply_error: 'push failed' }), SHIP_STATE.RESUME_APPLY,
      'the same answer with or without a recorded error — either way no branch was pushed',
    );
  });

  // Calling this "shipped" is what left a real commit with no PR: the draft
  // was never added to the batch's pending list, so finalizeBatchPr never
  // covered it.
  test("a 'branch_pushed' draft on THIS run's branch is awaiting its PR", () => {
    assert.equal(
      draftShipState({ status: 'branch_pushed', branch_name: 'batch-today' }, { currentBatchBranch: 'batch-today' }),
      SHIP_STATE.AWAITING_PR,
    );
  });

  // The commit a stale 'branch_pushed' draft refers to is a ghost — either on
  // a prior day's date-keyed branch, or never pushed at all because
  // endBatchPush cleared the chain without moving the ref. Queueing one would
  // have finalizeBatchPr mark it pr_opened against a PR that does not contain
  // its change: shipped-but-not-really, the worst possible report.
  test("a 'branch_pushed' draft from a PRIOR day's branch is stranded, not queued", () => {
    assert.equal(
      draftShipState({ status: 'branch_pushed', branch_name: 'batch-yesterday' }, { currentBatchBranch: 'batch-today' }),
      SHIP_STATE.STRANDED,
    );
  });

  test("a 'branch_pushed' draft carrying an apply_error is stranded — its commit was never pushed", () => {
    assert.equal(
      draftShipState({ status: 'branch_pushed', branch_name: 'batch-today', apply_error: 'push failed' }, { currentBatchBranch: 'batch-today' }),
      SHIP_STATE.STRANDED,
    );
  });

  test('with no batch branch given, a branch_pushed draft is never assumed live', () => {
    assert.equal(draftShipState({ status: 'branch_pushed', branch_name: 'batch-today' }), SHIP_STATE.STRANDED);
  });

  // generateDraft is idempotent per finding, so an unattended run gets back
  // exactly the draft a person is in the middle of reviewing. Resetting it
  // would destroy their work between opening the tab and clicking approve.
  test('a draft a human is reviewing is HUMAN_OWNED — never shipped, and never reset', () => {
    assert.equal(draftShipState({ status: 'submitted_for_approval' }), SHIP_STATE.HUMAN_OWNED);
    assert.equal(draftShipState({ status: 'revision_requested' }), SHIP_STATE.HUMAN_OWNED);
  });

  // Unrecognized reads as stranded, never as shipped: the caller's response to
  // stranded (abandon and regenerate) is safe for an unknown state, while
  // "shipped" would silently close out work that never happened.
  test('an unknown or missing status is stranded, never assumed shipped', () => {
    assert.equal(draftShipState({ status: 'some-future-status' }), SHIP_STATE.STRANDED);
    assert.equal(draftShipState({}), SHIP_STATE.STRANDED);
    assert.equal(draftShipState(null), SHIP_STATE.STRANDED);
  });
});
