// Tests for the agent's review of its own PR.
//
// The properties that matter here are mostly NEGATIVE ones — what the agent
// refuses to do, and what it refuses to call ready — because the failure mode
// this module guards against is a PR that looks clean to a reviewer while a
// check is red underneath.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  reviewPrChecks, classifyCheckFailure, generatedFilePaths,
  AGENT_REVIEW_STATE, FAILURE_CATEGORY, MAX_AGENT_FIX_ATTEMPTS,
} from './pr-self-review.js';
import { CLIENT_BUILD_CHECK_NAME } from './rendering-gate.js';

const SITE = { id: 1 };
const OUR_FILES = { content: { appliedFiles: [{ filePath: 'src/pages/x.md' }] } };
const runs = (list) => async () => list;
const done = (name, conclusion) => ({ name, status: 'completed', conclusion });

describe('the agent never merges', () => {
  test('no reachable state expresses "merged"', () => {
    // Structural, not a promise in a comment: 'merged' is not in the enum,
    // and migration 146's CHECK constraint rejects it at the database.
    assert.deepEqual(
      Object.values(AGENT_REVIEW_STATE).sort(),
      ['agent_fixing', 'agent_reviewing', 'needs_human_review', 'ready_for_human_review'],
    );
    assert.ok(!Object.values(AGENT_REVIEW_STATE).includes('merged'));
    assert.ok(!Object.values(AGENT_REVIEW_STATE).includes('implemented'));
  });

  test('an all-green PR reaches READY_FOR_HUMAN_REVIEW and stops there', async () => {
    const review = await reviewPrChecks(SITE, 'branch', OUR_FILES, {
      getCheckRuns: runs([done('unit', 'success'), done(CLIENT_BUILD_CHECK_NAME, 'success')]),
    });
    assert.equal(review.state, AGENT_REVIEW_STATE.READY);
    // READY is terminal for the agent — the next actor is a person.
    assert.notEqual(review.state, 'merged');
  });

  test('this module makes no merge call — it only ever reads check runs', async () => {
    const calls = [];
    await reviewPrChecks(SITE, 'branch', OUR_FILES, {
      getCheckRuns: async (...args) => { calls.push(args); return [done('unit', 'success')]; },
    });
    assert.equal(calls.length, 1, 'exactly one read, no writes to GitHub');
  });
});

describe('reads ALL checks, not just rendering-validation', () => {
  test('a failing unit test blocks the PR even when rendering-validation passes', async () => {
    // Before this module, only the rendering-validation check was ever read,
    // so this PR would have looked clean.
    const review = await reviewPrChecks(SITE, 'branch', OUR_FILES, {
      getCheckRuns: runs([done(CLIENT_BUILD_CHECK_NAME, 'success'), done('unit tests', 'failure')]),
    });
    assert.equal(review.state, AGENT_REVIEW_STATE.NEEDS_HUMAN);
    assert.match(review.reason, /unit tests/);
  });

  test('every passing check is reported, not just the count', async () => {
    const review = await reviewPrChecks(SITE, 'branch', OUR_FILES, {
      getCheckRuns: runs([done('unit', 'success'), done('typecheck', 'success')]),
    });
    assert.deepEqual(review.passed, ['unit', 'typecheck']);
  });

  test('neutral and skipped conclusions are not treated as failures', async () => {
    const review = await reviewPrChecks(SITE, 'branch', OUR_FILES, {
      getCheckRuns: runs([done('optional', 'skipped'), done('advisory', 'neutral'), done('unit', 'success')]),
    });
    assert.equal(review.state, AGENT_REVIEW_STATE.READY);
  });
});

describe('unknown is never reported as green', () => {
  test('unreadable checks escalate to a human instead of passing', async () => {
    const review = await reviewPrChecks(SITE, 'branch', OUR_FILES, {
      getCheckRuns: async () => { throw new Error('403 rate limited'); },
    });
    assert.equal(review.state, AGENT_REVIEW_STATE.NEEDS_HUMAN);
    assert.equal(review.checksVisible, false);
    assert.match(review.reason, /Unknown is not the same as green/);
  });

  test('checks still running leave the draft in review, resolving nothing', async () => {
    const review = await reviewPrChecks(SITE, 'branch', OUR_FILES, {
      getCheckRuns: runs([{ name: 'build', status: 'in_progress', conclusion: null }]),
    });
    assert.equal(review.state, AGENT_REVIEW_STATE.REVIEWING);
    assert.deepEqual(review.pending, ['build']);
  });

  test('a repo with no checks is reported ready, but says plainly that nothing was verified', async () => {
    const review = await reviewPrChecks(SITE, 'branch', OUR_FILES, { getCheckRuns: runs([]) });
    assert.equal(review.state, AGENT_REVIEW_STATE.READY);
    assert.equal(review.noChecksConfigured, true);
    assert.match(review.reason, /nothing here confirms the change builds/);
  });
});

describe('failure classification', () => {
  test('a check whose inputs the draft does not own is UNSAFE, with the reason recorded', () => {
    const result = classifyCheckFailure(done('integration tests', 'failure'), { draftGeneratedFiles: ['src/x.md'] });
    assert.equal(result.category, FAILURE_CATEGORY.UNSAFE);
    assert.match(result.reason, /does not own/);
  });

  test('a cancelled or timed-out run is TRANSIENT, and does not implicate the content', () => {
    for (const conclusion of ['cancelled', 'timed_out', 'stale']) {
      const result = classifyCheckFailure(done(CLIENT_BUILD_CHECK_NAME, conclusion), { draftGeneratedFiles: ['src/x.md'] });
      assert.equal(result.category, FAILURE_CATEGORY.TRANSIENT, `${conclusion} must be transient`);
      assert.match(result.reason, /not implicated/);
    }
  });

  test('rendering-validation failing on our own generated content is SAFE_TO_FIX', () => {
    const result = classifyCheckFailure(done(CLIENT_BUILD_CHECK_NAME, 'failure'), { draftGeneratedFiles: ['src/pages/x.md'] });
    assert.equal(result.category, FAILURE_CATEGORY.SAFE_TO_FIX);
    assert.match(result.reason, /content this draft generated/);
  });

  test('a sibling-template-family failure is UNSAFE even inside a safe-to-fix check', () => {
    // Same check run, different step: this one is a blast-radius problem in
    // the client's shared templates, which regenerating our content does not
    // address.
    const run = { ...done(CLIENT_BUILD_CHECK_NAME, 'failure'), output: { summary: 'change leaked into sibling pages of a shared template family' } };
    const result = classifyCheckFailure(run, { draftGeneratedFiles: ['src/pages/x.md'] });
    assert.equal(result.category, FAILURE_CATEGORY.UNSAFE);
    assert.match(result.reason, /blast-radius|sibling/i);
  });

  test('a draft with no recorded files is ITEM_DEFECT — scope cannot be established, so nothing is guessed', () => {
    const result = classifyCheckFailure(done(CLIENT_BUILD_CHECK_NAME, 'failure'), { draftGeneratedFiles: [] });
    assert.equal(result.category, FAILURE_CATEGORY.ITEM_DEFECT);
    assert.match(result.reason, /scope of a corrective edit cannot be established/);
  });

  test('every classification carries a recorded reason', () => {
    for (const run of [done('x', 'failure'), done(CLIENT_BUILD_CHECK_NAME, 'failure'), done('y', 'cancelled')]) {
      const result = classifyCheckFailure(run, { draftGeneratedFiles: ['a.md'] });
      assert.ok(result.reason && result.reason.length > 20, 'a classification without a reason is not auditable');
      assert.ok(result.category);
    }
  });
});

describe('failures are never hidden to reach READY', () => {
  test('one unfixable failure decides the outcome even alongside a fixable one', async () => {
    const review = await reviewPrChecks(SITE, 'branch', OUR_FILES, {
      getCheckRuns: runs([done(CLIENT_BUILD_CHECK_NAME, 'failure'), done('typecheck', 'failure')]),
    });
    assert.equal(review.state, AGENT_REVIEW_STATE.NEEDS_HUMAN);
  });

  test('every failure is recorded, including ones the agent cannot act on', async () => {
    const review = await reviewPrChecks(SITE, 'branch', OUR_FILES, {
      getCheckRuns: runs([done('unit', 'failure'), done('lint', 'failure'), done('build', 'failure')]),
    });
    assert.equal(review.failures.length, 3);
    assert.deepEqual(review.failures.map((f) => f.check).sort(), ['build', 'lint', 'unit']);
  });
});

describe('the fix loop is bounded', () => {
  test('a draft at the attempt limit escalates instead of retrying forever', async () => {
    const exhausted = { ...OUR_FILES, agent_fix_attempts: MAX_AGENT_FIX_ATTEMPTS };
    const review = await reviewPrChecks(SITE, 'branch', exhausted, {
      getCheckRuns: runs([done(CLIENT_BUILD_CHECK_NAME, 'failure')]),
    });
    assert.equal(review.state, AGENT_REVIEW_STATE.NEEDS_HUMAN);
    assert.match(review.reason, /Escalating rather than retrying/);
  });

  test('below the limit, a genuinely safe failure enters the fixing state', async () => {
    const review = await reviewPrChecks(SITE, 'branch', { ...OUR_FILES, agent_fix_attempts: 0 }, {
      getCheckRuns: runs([done(CLIENT_BUILD_CHECK_NAME, 'failure')]),
    });
    assert.equal(review.state, AGENT_REVIEW_STATE.FIXING);
  });
});

describe('generatedFilePaths', () => {
  test('reads the files recorded at branch-push time', () => {
    assert.deepEqual(generatedFilePaths({ content: { appliedFiles: [{ filePath: 'a.md' }, { filePath: 'b.njk' }] } }), ['a.md', 'b.njk']);
  });

  test('a draft with no recorded files yields none rather than throwing', () => {
    assert.deepEqual(generatedFilePaths({}), []);
    assert.deepEqual(generatedFilePaths({ content: {} }), []);
    assert.deepEqual(generatedFilePaths(null), []);
  });
});
