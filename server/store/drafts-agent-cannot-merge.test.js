// THE non-negotiable, asserted against the real database rather than trusted
// by inspection: nothing the agent can do produces a merged draft.
//
// Real-DB convention, same as data-analyst-tenant-isolation.test.js — two
// genuinely inserted rows, deleted in after().

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { query, pool } from '../db.js';
import { recordAgentReviewState, markDraftImplemented, recordPrState } from './drafts.js';
import { AGENT_REVIEW_STATE } from '../implementers/lib/pr-self-review.js';

let site;
let draft;

before(async () => {
  const s = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id)
     VALUES ('Agent Merge Guard Site', 'sc-domain:agent-merge-guard.example', 'test-ga4-amg') RETURNING *`
  );
  site = s.rows[0];
  const d = await query(
    `INSERT INTO drafts (site_id, action_type, status, input, content, branch_name, pr_number, pr_url, pr_state)
     VALUES ($1, 'meta-title', 'pr_opened', '{}'::jsonb, '{}'::jsonb, 'action-center/batch-x', 4242, 'https://github.com/x/y/pull/4242', 'open')
     RETURNING *`,
    [site.id]
  );
  draft = d.rows[0];
});

after(async () => {
  await query('DELETE FROM drafts WHERE site_id = $1', [site.id]);
  await query('DELETE FROM sites WHERE id = $1', [site.id]);
  await pool.end();
});

describe('the agent cannot merge', () => {
  test('the database rejects any attempt to record a merged agent review state', async () => {
    // Not merely absent from the enum in JS — the CHECK constraint added by
    // migration 146 refuses it, so even a future caller that invented the
    // value could not persist it.
    await assert.rejects(
      () => recordAgentReviewState(site.id, draft.id, 'merged'),
      /agent_review_state_check|violates check constraint/i,
      'the schema itself must reject a merged agent review state',
    );
    await assert.rejects(
      () => recordAgentReviewState(site.id, draft.id, 'implemented'),
      /agent_review_state_check|violates check constraint/i,
    );
  });

  test('reaching the agent\'s terminal states leaves drafts.status at pr_opened', async () => {
    // The agent finishing its review must not advance the change's own
    // lifecycle — that is a human's move.
    for (const state of [AGENT_REVIEW_STATE.REVIEWING, AGENT_REVIEW_STATE.FIXING, AGENT_REVIEW_STATE.READY, AGENT_REVIEW_STATE.NEEDS_HUMAN]) {
      const updated = await recordAgentReviewState(site.id, draft.id, state, { reason: 'test' });
      assert.equal(updated.agent_review_state, state);
      assert.equal(updated.status, 'pr_opened', `${state} must not move drafts.status`);
      assert.notEqual(updated.pr_state, 'merged');
    }
  });

  test('READY_FOR_HUMAN_REVIEW does not make the draft implementable', async () => {
    // The strongest thing the agent can say is "ready". If that alone let a
    // draft finalize, the human merge gate would be decorative.
    await recordAgentReviewState(site.id, draft.id, AGENT_REVIEW_STATE.READY, { reason: 'all checks passed' });
    const result = await markDraftImplemented(site.id, draft.id);
    assert.equal(result, null, 'a draft the agent called ready must NOT finalize without a real merge');

    const { rows } = await query('SELECT status FROM drafts WHERE id = $1', [draft.id]);
    assert.equal(rows[0].status, 'pr_opened');
  });

  test('only GitHub-confirmed evidence of a human merge finalizes a draft', async () => {
    // recordPrState is written from what GitHub reports, not from anything
    // this app decides. Once it says merged — i.e. a person merged the PR —
    // the draft finalizes.
    await recordPrState(site.id, draft.id, 'merged');
    const implemented = await markDraftImplemented(site.id, draft.id);
    assert.ok(implemented, 'a genuinely merged PR must finalize');
    assert.equal(implemented.status, 'implemented');
  });

  test('the agent review column is orthogonal — finalizing did not depend on it', async () => {
    const { rows } = await query('SELECT status, agent_review_state FROM drafts WHERE id = $1', [draft.id]);
    assert.equal(rows[0].status, 'implemented');
    // Still whatever the agent last recorded: the two lifecycles are separate.
    assert.equal(rows[0].agent_review_state, AGENT_REVIEW_STATE.READY);
  });
});

describe('agent fix attempts are counted, not assumed', () => {
  test('the counter only advances when a fix was actually pushed', async () => {
    const d = await query(
      `INSERT INTO drafts (site_id, action_type, status, input, content)
       VALUES ($1, 'meta-title', 'pr_opened', '{}'::jsonb, '{}'::jsonb) RETURNING *`,
      [site.id]
    );
    const id = d.rows[0].id;
    assert.equal(d.rows[0].agent_fix_attempts, 0);

    const reviewed = await recordAgentReviewState(site.id, id, AGENT_REVIEW_STATE.REVIEWING, {});
    assert.equal(reviewed.agent_fix_attempts, 0, 'reviewing is not a fix attempt');

    const fixed = await recordAgentReviewState(site.id, id, AGENT_REVIEW_STATE.FIXING, {}, { bumpFixAttempt: true });
    assert.equal(fixed.agent_fix_attempts, 1);
  });
});
