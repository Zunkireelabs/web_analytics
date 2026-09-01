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
  test("a draft at 'branch_pushed' has a real commit still awaiting its PR", () => {
    assert.equal(draftShipState({ status: 'branch_pushed' }), SHIP_STATE.AWAITING_PR);
  });

  test('a draft awaiting human revision is stranded — no automatic step can advance it', () => {
    assert.equal(draftShipState({ status: 'revision_requested' }), SHIP_STATE.STRANDED);
    assert.equal(draftShipState({ status: 'submitted_for_approval' }), SHIP_STATE.STRANDED);
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
