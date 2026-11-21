import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  codeSelfRepairEnabled, codeProblemSignature, countDistinctFailureDays,
  maybeEscalateToCodeRepair, acceptDesignRepairTask, applyKnownFix, investigateAndRepair, openPlatformRepairPr,
  PLATFORM_REPO,
} from './code-self-repair.js';

// Every DB/GitHub/OpenHands boundary is injected — this suite never touches
// a real database, GitHub API, or Docker/OpenHands sandbox, same
// dependency-injection convention as data-array-content.js's fetchFile and
// openhands-handler.test.js's pythonBin/scriptPath stubs.

function fakeQuery(rowsByCall) {
  let call = 0;
  return async () => rowsByCall[Math.min(call++, rowsByCall.length - 1)];
}

describe('codeSelfRepairEnabled', () => {
  test('off by default — no env var set', () => {
    assert.equal(codeSelfRepairEnabled({}), false);
  });
  test('off for any value other than the literal string "true"', () => {
    assert.equal(codeSelfRepairEnabled({ ENABLE_CODE_SELF_REPAIR: '1' }), false);
    assert.equal(codeSelfRepairEnabled({ ENABLE_CODE_SELF_REPAIR: 'yes' }), false);
  });
  test('on only when explicitly "true"', () => {
    assert.equal(codeSelfRepairEnabled({ ENABLE_CODE_SELF_REPAIR: 'true' }), true);
  });
});

describe('codeProblemSignature', () => {
  test('deterministic generatorId:reason key', () => {
    assert.equal(codeProblemSignature('expand-content', 'invalid-edit'), 'expand-content:invalid-edit');
  });
});

describe('countDistinctFailureDays', () => {
  test('reads the days count off the injected query', async () => {
    const queryFn = fakeQuery([{ rows: [{ days: '3' }] }]);
    const days = await countDistinctFailureDays('expand-content', 'invalid-edit', { queryFn });
    assert.equal(days, 3);
  });
  test('zero for missing generatorId/reason without querying', async () => {
    const days = await countDistinctFailureDays(null, 'invalid-edit', { queryFn: fakeQuery([{ rows: [{ days: '9' }] }]) });
    assert.equal(days, 0);
  });
});

describe('maybeEscalateToCodeRepair — feature flag and evidence gate', () => {
  test('does nothing when ENABLE_CODE_SELF_REPAIR is not set (existing client content-remediation behavior is entirely untouched by this)', async () => {
    const result = await maybeEscalateToCodeRepair(
      { generatorId: 'expand-content', reason: 'invalid-edit', errorMessage: 'boom' },
      { env: {} },
    );
    assert.equal(result.escalated, false);
    assert.equal(result.reason, 'disabled');
  });

  test('one isolated failure (0 or 1 distinct day) does not trigger self-repair', async () => {
    const queryFn = fakeQuery([{ rows: [{ days: '1' }] }]);
    const result = await maybeEscalateToCodeRepair(
      { generatorId: 'expand-content', reason: 'invalid-edit', errorMessage: 'boom' },
      { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, queryFn },
    );
    assert.equal(result.escalated, false);
    assert.equal(result.reason, 'insufficient-evidence');
  });

  test('the same (generatorId, reason) failing on 2 distinct calendar days triggers escalation', async () => {
    let queryCall = 0;
    const queryFn = async () => {
      queryCall++;
      if (queryCall === 1) return { rows: [{ days: '2' }] }; // countDistinctFailureDays
      return { rows: [] }; // lookupCodeLesson — none exists yet
    };
    let investigated = false;
    const investigateAndRepairFn = async () => { investigated = true; return { ok: true, prUrl: 'https://github.com/x/y/pull/1', filesChanged: ['server/a.js'] }; };
    const result = await maybeEscalateToCodeRepair(
      { generatorId: 'expand-content', reason: 'invalid-edit', errorMessage: 'boom' },
      { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, queryFn, investigateAndRepairFn, recordFixOutcomeFn: async () => {} },
    );
    assert.equal(investigated, true);
    assert.equal(result.escalated, true);
    assert.equal(result.path, 'unknown-issue');
    assert.equal(result.ok, true);
  });
});

describe('maybeEscalateToCodeRepair — known-issue reuse path', () => {
  test('an existing trusted code lesson with a stored patch is reused instead of investigating', async () => {
    const lessonRow = { id: 42, status: 'trusted', fix_pattern: 'diff --git a/server/x.js b/server/x.js\n...', generator_id: 'expand-content', problem_signature: 'expand-content:invalid-edit' };
    let queryCall = 0;
    const queryFn = async () => {
      queryCall++;
      if (queryCall === 1) return { rows: [{ days: '2' }] };
      return { rows: [lessonRow] };
    };
    let investigated = false;
    const applyKnownFixFn = async (row) => { assert.equal(row.id, 42); return { ok: true, prUrl: 'https://github.com/x/y/pull/2' }; };
    const investigateAndRepairFn = async () => { investigated = true; return { ok: false }; };
    let recorded = null;
    const recordFixOutcomeFn = async (args) => { recorded = args; };

    const result = await maybeEscalateToCodeRepair(
      { generatorId: 'expand-content', reason: 'invalid-edit', errorMessage: 'boom' },
      { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, queryFn, applyKnownFixFn, investigateAndRepairFn, recordFixOutcomeFn },
    );

    assert.equal(investigated, false, 'a known-issue reuse must never spawn a fresh OpenHands investigation');
    assert.equal(result.path, 'known-issue');
    assert.equal(result.ok, true);
    assert.equal(recorded.memoryRefId, 42);
    assert.equal(recorded.outcome, 'success');
  });

  test('a stale/non-applicable stored patch falls through to a fresh OpenHands investigation', async () => {
    const lessonRow = { id: 42, status: 'trusted', fix_pattern: 'diff --git a/server/x.js b/server/x.js\n...', generator_id: 'expand-content' };
    let queryCall = 0;
    const queryFn = async () => {
      queryCall++;
      if (queryCall === 1) return { rows: [{ days: '2' }] };
      return { rows: [lessonRow] };
    };
    const applyKnownFixFn = async () => ({ ok: false, reason: 'patch-stale' });
    let investigated = false;
    const investigateAndRepairFn = async () => { investigated = true; return { ok: true, prUrl: 'https://github.com/x/y/pull/3', filesChanged: ['server/x.js'] }; };

    const result = await maybeEscalateToCodeRepair(
      { generatorId: 'expand-content', reason: 'invalid-edit', errorMessage: 'boom' },
      { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, queryFn, applyKnownFixFn, investigateAndRepairFn, recordFixOutcomeFn: async () => {} },
    );

    assert.equal(investigated, true, 'a stale patch must fall through to investigation, not be forced or silently dropped');
    assert.equal(result.path, 'unknown-issue');
    assert.equal(result.ok, true);
  });

  test('no existing lesson never causes an attempt to reuse anything — investigation runs directly', async () => {
    let queryCall = 0;
    const queryFn = async () => {
      queryCall++;
      if (queryCall === 1) return { rows: [{ days: '2' }] };
      return { rows: [] };
    };
    let applyCalled = false;
    const applyKnownFixFn = async () => { applyCalled = true; return { ok: true }; };
    const investigateAndRepairFn = async () => ({ ok: true, prUrl: 'https://github.com/x/y/pull/4', filesChanged: ['server/a.js'] });

    await maybeEscalateToCodeRepair(
      { generatorId: 'expand-content', reason: 'invalid-edit', errorMessage: 'boom' },
      { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, queryFn, applyKnownFixFn, investigateAndRepairFn, recordFixOutcomeFn: async () => {} },
    );
    assert.equal(applyCalled, false);
  });
});

describe('maybeEscalateToCodeRepair — bounded retry, never retries forever, never claims a false success', () => {
  test('a fresh problem that keeps failing is flagged for review after the bounded attempt limit, not retried forever', async () => {
    let queryCall = 0;
    const queryFn = async () => {
      queryCall++;
      if (queryCall === 1) return { rows: [{ days: '2' }] };
      if (queryCall === 2) return { rows: [] }; // no existing lesson
      return { rows: [] }; // the flagUnresolved INSERT
    };
    let attempts = 0;
    const investigateAndRepairFn = async () => { attempts++; return { ok: false, reason: 'validation-failed', detail: 'tests still fail' }; };
    let recordedSuccess = false;
    const recordFixOutcomeFn = async (args) => { if (args.outcome === 'success') recordedSuccess = true; };

    const result = await maybeEscalateToCodeRepair(
      { generatorId: 'expand-content', reason: 'invalid-edit', errorMessage: 'boom' },
      { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, queryFn, investigateAndRepairFn, recordFixOutcomeFn, maxFreshAttempts: 2 },
    );

    assert.equal(attempts, 2, 'must stop after the bounded attempt limit, never loop forever');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'flagged_for_review');
    assert.equal(recordedSuccess, false, 'a failed repair must never be recorded as a success');
  });

  test('once flagged_for_review, a later trigger does not spawn another investigation (visible to a human, not silently retried)', async () => {
    const flaggedRow = { id: 99, status: 'flagged_for_review', fix_pattern: null, generator_id: 'expand-content' };
    let queryCall = 0;
    const queryFn = async () => {
      queryCall++;
      if (queryCall === 1) return { rows: [{ days: '5' }] };
      return { rows: [flaggedRow] };
    };
    let investigated = false;
    const investigateAndRepairFn = async () => { investigated = true; return { ok: true, filesChanged: ['x'] }; };

    const result = await maybeEscalateToCodeRepair(
      { generatorId: 'expand-content', reason: 'invalid-edit', errorMessage: 'boom' },
      { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, queryFn, investigateAndRepairFn },
    );

    assert.equal(investigated, false);
    assert.equal(result.escalated, false);
    assert.equal(result.reason, 'already-flagged-for-human-review');
  });
});

describe('investigateAndRepair — cannot claim success without real validation', () => {
  test('a sandbox result with testsPassed=false (or the handler throwing, matching a real design_task.py validation-gate rejection) is never treated as ok', async () => {
    const thrown = Object.assign(new Error("The Design Agent finished but reported that it could not analyse this site's repository."), {});
    const codeSelfRepairHandlerFn = async () => { throw thrown; };
    const result = await investigateAndRepair(
      { generatorId: 'expand-content', reasonKey: 'invalid-edit', errorMessage: 'boom', occurrenceDays: 2, testFileHint: null },
      { codeSelfRepairHandlerFn },
    );
    assert.equal(result.ok, false);
  });

  test('a handler result with no files actually changed is not a successful repair, even if testsPassed reports true', async () => {
    const codeSelfRepairHandlerFn = async () => ({ testsPassed: true, filesChanged: [], detail: 'nothing changed' });
    const result = await investigateAndRepair(
      { generatorId: 'expand-content', reasonKey: 'invalid-edit', errorMessage: 'boom', occurrenceDays: 2, testFileHint: null },
      { codeSelfRepairHandlerFn },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'validation-failed');
  });

  test('a real successful repair opens a platform PR and returns the patch/rootCause for the lesson row', async () => {
    const codeSelfRepairHandlerFn = async () => ({
      testsPassed: true,
      filesChanged: [{ path: 'server/implementers/adapters/lib/js-data-splice.js', newContent: 'fixed content\n' }],
      patch: 'diff --git a/server/implementers/adapters/lib/js-data-splice.js b/server/implementers/adapters/lib/js-data-splice.js\n...',
      rootCause: 'missing newline escaping', summary: 'escape newlines', testOutput: '# pass 1',
    });
    let openedWith = null;
    const openPlatformRepairPrFn = async (args) => { openedWith = args; return { ok: true, prUrl: 'https://github.com/Zunkireelabs/web_analytics/pull/500', prNumber: 500, branchName: 'fix/self-repair-x' }; };

    const result = await investigateAndRepair(
      { generatorId: 'expand-content', reasonKey: 'invalid-edit', errorMessage: 'boom', occurrenceDays: 2, testFileHint: null },
      { codeSelfRepairHandlerFn, openPlatformRepairPrFn },
    );

    assert.equal(result.ok, true);
    assert.equal(result.prUrl, 'https://github.com/Zunkireelabs/web_analytics/pull/500');
    assert.equal(openedWith.files.length, 1);
    assert.equal(openedWith.files[0].path, 'server/implementers/adapters/lib/js-data-splice.js');
  });

  test('a successful sandbox fix whose PR fails to open is not treated as a success', async () => {
    const codeSelfRepairHandlerFn = async () => ({ testsPassed: true, filesChanged: [{ path: 'server/a.js', newContent: 'x' }] });
    const openPlatformRepairPrFn = async () => ({ ok: false, error: 'GitHub 500' });
    const result = await investigateAndRepair(
      { generatorId: 'expand-content', reasonKey: 'invalid-edit', errorMessage: 'boom', occurrenceDays: 2, testFileHint: null },
      { codeSelfRepairHandlerFn, openPlatformRepairPrFn },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pr-open-failed');
  });
});

describe('applyKnownFix — mechanical reuse of a stored patch, real validation before any PR', () => {
  test('a patch that no longer applies cleanly is reported as stale, not forced', async () => {
    const lessonRow = { id: 1, fix_pattern: 'diff --git a/server/x.js b/server/x.js\n@@ -1 +1 @@\n-old\n+new\n' };
    const execFileFn = async (cmd, args) => {
      if (cmd === 'patch' && args.includes('--dry-run')) throw new Error('patch does not apply');
      throw new Error('unexpected call');
    };
    const result = await applyKnownFix(lessonRow, {
      checkoutRepoTarballFn: async () => {},
      execFileFn,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'patch-stale');
  });

  test('a lesson with no stored patch at all cannot be "applied"', async () => {
    const result = await applyKnownFix({ id: 2, fix_pattern: null }, {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-stored-patch');
  });
});

describe('openPlatformRepairPr — targets the platform repo\'s own base branch, never auto-merges', () => {
  test('opens a fix/self-repair/* branch and PR against PLATFORM_REPO.repo_default_branch, reusing an already-open PR instead of erroring', async () => {
    let createdBranch = null;
    let openedPr = null;
    const listOpenPullRequestsForBranchFn = async () => [];
    const getBranchShaFn = async () => 'base-sha-123';
    const createBranchFn = async (repo, branch, sha) => { createdBranch = { repo, branch, sha }; };
    const commitFilesAtomicFn = async () => {};
    const openPullRequestFn = async (repo, args) => { openedPr = { repo, ...args }; return { number: 1, url: 'https://github.com/Zunkireelabs/web_analytics/pull/1' }; };

    const result = await openPlatformRepairPr({
      slug: 'expand-content-invalid-edit', title: 'fix escaping', body: 'body text',
      files: [{ path: 'server/a.js', content: 'x' }],
      listOpenPullRequestsForBranchFn, getBranchShaFn, createBranchFn, commitFilesAtomicFn, openPullRequestFn,
    });

    assert.equal(result.ok, true);
    assert.equal(result.branchName, 'fix/self-repair-expand-content-invalid-edit');
    assert.equal(createdBranch.repo, PLATFORM_REPO);
    assert.equal(createdBranch.sha, 'base-sha-123');
    assert.equal(openedPr.repo, PLATFORM_REPO);
    assert.equal(result.prUrl, 'https://github.com/Zunkireelabs/web_analytics/pull/1');
  });

  test('reuses an already-open PR for the same branch instead of opening a duplicate', async () => {
    const listOpenPullRequestsForBranchFn = async () => [{ number: 7, html_url: 'https://github.com/Zunkireelabs/web_analytics/pull/7' }];
    let createBranchCalled = false;
    const result = await openPlatformRepairPr({
      slug: 'x', title: 't', body: 'b', files: [],
      listOpenPullRequestsForBranchFn,
      createBranchFn: async () => { createBranchCalled = true; },
      getBranchShaFn: async () => 'sha', commitFilesAtomicFn: async () => {}, openPullRequestFn: async () => { throw new Error('must not open a new PR'); },
    });
    assert.equal(result.reused, true);
    assert.equal(createBranchCalled, false);
    assert.equal(result.prUrl, 'https://github.com/Zunkireelabs/web_analytics/pull/7');
  });
});

describe('multi-client behavior — platform lessons apply regardless of which site produced the failure', () => {
  test('the escalation signal is keyed only by (generatorId, reason), never by siteId — the same signature triggers for site 1 or site 2', async () => {
    const queryFn = fakeQuery([{ rows: [{ days: '2' }] }]);
    const daysForSite1 = await countDistinctFailureDays('expand-content', 'invalid-edit', { queryFn });
    const daysForSite2 = await countDistinctFailureDays('expand-content', 'invalid-edit', { queryFn: fakeQuery([{ rows: [{ days: '2' }] }]) });
    assert.equal(daysForSite1, daysForSite2, 'the count query itself is never filtered by site — see the SQL, which has no site_id predicate');
  });

  test('a stored lesson is scope=repo/site_id=NULL by construction, so any site\'s siteId never changes which lesson is looked up', async () => {
    const lessonRow = { id: 1, status: 'trusted', fix_pattern: 'diff --git a/server/x.js b/server/x.js\n...' };
    for (const siteId of [1, 2, null]) {
      let queryCall = 0;
      const queryFn = async () => {
        queryCall++;
        if (queryCall === 1) return { rows: [{ days: '2' }] };
        return { rows: [lessonRow] };
      };
      const applyKnownFixFn = async () => ({ ok: true, prUrl: 'https://x/pull/1' });
      const result = await maybeEscalateToCodeRepair(
        { generatorId: 'expand-content', reason: 'invalid-edit', errorMessage: 'boom', siteId },
        { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, queryFn, applyKnownFixFn, recordFixOutcomeFn: async () => {} },
      );
      assert.equal(result.ok, true, `siteId=${siteId} must reuse the same platform lesson`);
    }
  });
});

describe('maybeEscalateToCodeRepair — caller-verified evidence (design-repair.js diagnosis)', () => {
  const rows = (lesson = null) => {
    let n = 0;
    return async () => { n++; return n === 1 ? { rows: [{ days: '0' }] } : { rows: lesson ? [lesson] : [] }; };
  };

  test('a deterministic diagnosis starts the investigation without waiting for a second calendar day', async () => {
    let investigated = false;
    const result = await maybeEscalateToCodeRepair(
      { generatorId: 'direct-answer', reason: 'design-shared-renderer', errorMessage: 'generic evidence' },
      { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, queryFn: rows(), verifiedEvidence: true, recordFixOutcomeFn: async () => {},
        investigateAndRepairFn: async () => { investigated = true; return { ok: true, prUrl: 'https://github.com/x/y/pull/9', filesChanged: ['server/a.js'] }; } },
    );
    assert.equal(investigated, true);
    assert.equal(result.escalated, true);
  });

  test('without verified evidence the same 0-day history still does NOT escalate', async () => {
    const result = await maybeEscalateToCodeRepair(
      { generatorId: 'direct-answer', reason: 'design-shared-renderer', errorMessage: 'x' },
      { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, queryFn: rows(), investigateAndRepairFn: async () => ({ ok: true }) },
    );
    assert.equal(result.reason, 'insufficient-evidence');
  });

  test('verified evidence does not bypass the feature flag', async () => {
    const result = await maybeEscalateToCodeRepair(
      { generatorId: 'direct-answer', reason: 'design-shared-renderer', errorMessage: 'x' },
      { env: {}, queryFn: rows(), verifiedEvidence: true, investigateAndRepairFn: async () => ({ ok: true }) },
    );
    assert.equal(result.reason, 'disabled');
  });

  test('verified evidence does not re-open a problem already flagged for a human', async () => {
    const result = await maybeEscalateToCodeRepair(
      { generatorId: 'direct-answer', reason: 'design-shared-renderer', errorMessage: 'x' },
      { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, queryFn: rows({ status: 'flagged_for_review' }), verifiedEvidence: true, investigateAndRepairFn: async () => ({ ok: true }) },
    );
    assert.equal(result.reason, 'already-flagged-for-human-review');
  });
});

describe('acceptDesignRepairTask — did anyone take responsibility? (design-repair.js hand-off)', () => {
  const task = { generatorId: 'direct-answer', owner: 'shared-renderer', errorMessage: 'generic evidence', testFileHint: 'server/x.test.js' };
  const lessonQuery = (lesson) => async () => ({ rows: lesson ? [lesson] : [] });
  const sync = (fn) => fn();

  test('DISABLED (production today): not accepted, so the caller hands the item to a person — nothing is started', async () => {
    let started = false;
    const r = await acceptDesignRepairTask(task, { env: {}, queryFn: lessonQuery(null), escalateFn: async () => { started = true; } });
    assert.deepEqual(r, { accepted: false, reason: 'disabled' });
    assert.equal(started, false);
  });

  test('ENABLED, nothing known: accepted, and the investigation starts with the diagnosis as verified evidence', async () => {
    const calls = [];
    let finished;
    const done = new Promise((res) => { finished = res; });
    const r = await acceptDesignRepairTask(task, {
      env: { ENABLE_CODE_SELF_REPAIR: 'true' }, getBranchShaFn: async () => 'sha', queryFn: lessonQuery(null),
      escalateFn: async (args, deps) => { calls.push([args, deps]); finished(); return { escalated: true, ok: true }; },
      detach: sync,
    });
    await done;
    assert.deepEqual(r, { accepted: true, reason: 'started' });
    const [args, deps] = calls[0];
    assert.equal(args.reason, 'design-shared-renderer');
    assert.equal(args.siteId, null, 'a shared engineering task never carries a tenant id');
    assert.equal(deps.verifiedEvidence, true);
    assert.equal(deps.testFileHint, 'server/x.test.js');
  });

  test('FAILED earlier (flagged for review): not accepted — automation already gave up, so a person gets it', async () => {
    const r = await acceptDesignRepairTask(task, { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, getBranchShaFn: async () => 'sha', queryFn: lessonQuery({ status: 'flagged_for_review' }), escalateFn: async () => { throw new Error('must not run'); } });
    assert.deepEqual(r, { accepted: false, reason: 'already-flagged-for-human-review' });
  });

  test('a deprecated lesson is not accepted either', async () => {
    const r = await acceptDesignRepairTask(task, { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, getBranchShaFn: async () => 'sha', queryFn: lessonQuery({ status: 'deprecated' }), escalateFn: async () => {} });
    assert.equal(r.accepted, false);
  });

  test('a repair for this root cause already exists: accepted (its PR reviewer has it) and nothing new is started', async () => {
    let started = false;
    const r = await acceptDesignRepairTask(task, { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, getBranchShaFn: async () => 'sha', queryFn: lessonQuery({ status: 'candidate', fix_pattern: 'diff --git ...' }), escalateFn: async () => { started = true; } });
    assert.deepEqual(r, { accepted: true, reason: 'repair-already-proposed' });
    assert.equal(started, false);
  });

  test('IN PROGRESS: a second request for the same root cause joins it instead of starting a duplicate', async () => {
    let release; const gate = new Promise((res) => { release = res; });
    let runs = 0;
    const deps = { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, getBranchShaFn: async () => 'sha', queryFn: lessonQuery(null), escalateFn: async () => { runs++; await gate; return { escalated: true, ok: true }; }, detach: sync };
    const first = await acceptDesignRepairTask({ ...task, generatorId: 'landing-page' }, deps);
    const second = await acceptDesignRepairTask({ ...task, generatorId: 'landing-page' }, deps);
    assert.equal(first.reason, 'started');
    assert.equal(second.reason, 'already-in-progress');
    assert.equal(runs, 1);
    release();
    await gate;
    await new Promise((r) => setImmediate(r));
    const third = await acceptDesignRepairTask({ ...task, generatorId: 'landing-page' }, deps);
    assert.equal(third.reason, 'started', 'once finished it can be requested again');
    release();
  });

  test('the investigation THROWING later never reaches the caller — and frees the slot', async () => {
    let finished; const done = new Promise((res) => { finished = res; });
    const deps = { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, getBranchShaFn: async () => 'sha', queryFn: lessonQuery(null), detach: sync,
      escalateFn: async () => { setImmediate(finished); throw new Error('sandbox crashed'); } };
    const r = await acceptDesignRepairTask({ ...task, generatorId: 'translation' }, deps);
    await done; await new Promise((res) => setImmediate(res));
    assert.equal(r.accepted, true);
    const again = await acceptDesignRepairTask({ ...task, generatorId: 'translation' }, { ...deps, escalateFn: async () => ({}) });
    assert.equal(again.reason, 'started');
  });

  test('a lesson lookup that fails is NOT assumed fine: not accepted, so a person gets it', async () => {
    const r = await acceptDesignRepairTask(task, { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, getBranchShaFn: async () => 'sha', queryFn: async () => { throw new Error('db down'); }, escalateFn: async () => {} });
    assert.deepEqual(r, { accepted: false, reason: 'lookup-failed' });
  });

  test('missing generator or owner is refused, never started', async () => {
    assert.equal((await acceptDesignRepairTask({ owner: 'shared-renderer' }, { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, getBranchShaFn: async () => 'sha', queryFn: lessonQuery(null) })).accepted, false);
    assert.equal((await acceptDesignRepairTask({ generatorId: 'faq' }, { env: { ENABLE_CODE_SELF_REPAIR: 'true' }, getBranchShaFn: async () => 'sha', queryFn: lessonQuery(null) })).accepted, false);
  });
});

describe('platform repairs fail CLOSED on the target branch (never main)', () => {
  const task = { generatorId: 'direct-answer', owner: 'shared-renderer', errorMessage: 'e' };
  const enabled = { ENABLE_CODE_SELF_REPAIR: 'true' };
  const noLesson = async () => ({ rows: [] });

  test('no stage branch on the repo: NOT accepted, before any LLM spend — a person gets the evidence', async () => {
    let started = false;
    const r = await acceptDesignRepairTask(task, { env: enabled, queryFn: noLesson, getBranchShaFn: async () => { throw new Error('Not Found'); }, escalateFn: async () => { started = true; } });
    assert.deepEqual(r, { accepted: false, reason: 'stage-branch-missing' });
    assert.equal(started, false);
  });

  test('stage configured as the production branch: NOT accepted (never retargeted at main)', async () => {
    const r = await acceptDesignRepairTask(task, { env: { ...enabled, PLATFORM_REPO_BASE_BRANCH: 'main' }, queryFn: noLesson, getBranchShaFn: async () => 'sha', escalateFn: async () => {} });
    assert.deepEqual(r, { accepted: false, reason: 'unsafe-base-branch' });
  });

  test('stage exists: accepted as before', async () => {
    const r = await acceptDesignRepairTask(task, { env: enabled, queryFn: noLesson, getBranchShaFn: async () => 'sha', escalateFn: async () => ({}), detach: (fn) => fn() });
    assert.equal(r.accepted, true);
  });

  test('openPlatformRepairPr refuses to open anything when the target is production', async () => {
    const prev = process.env.PLATFORM_REPO_BASE_BRANCH;
    process.env.PLATFORM_REPO_BASE_BRANCH = 'main';
    try {
      let touched = false;
      const r = await openPlatformRepairPr({ slug: 's', title: 't', body: 'b', files: [], createBranchFn: async () => { touched = true; }, getBranchShaFn: async () => { touched = true; } });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'unsafe-base-branch');
      assert.equal(touched, false, 'not even a branch is created');
    } finally { if (prev === undefined) delete process.env.PLATFORM_REPO_BASE_BRANCH; else process.env.PLATFORM_REPO_BASE_BRANCH = prev; }
  });

  test('a missing stage branch is reported as exactly that, not as a retryable error', async () => {
    const r = await openPlatformRepairPr({ slug: 's', title: 't', body: 'b', files: [], listOpenPullRequestsForBranchFn: async () => [], getBranchShaFn: async () => { throw new Error('getBranchSha failed (404): Not Found'); } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'stage-branch-missing');
  });
});

describe('agent work is CUT from main and the PR goes INTO stage', () => {
  test('the branch is created from the production branch tip, and the PR targets the stage branch', async () => {
    const seen = {};
    const r = await openPlatformRepairPr({
      slug: 'x', title: 't', body: 'b', files: [{ path: 'server/a.js', content: 'c' }],
      listOpenPullRequestsForBranchFn: async () => [],
      getBranchShaFn: async (_repo, branch) => { seen.cutFrom = branch; return 'MAINSHA'; },
      createBranchFn: async (_repo, name, sha) => { seen.created = [name, sha]; },
      commitFilesAtomicFn: async () => {},
      openPullRequestFn: async (_repo, args) => { seen.pr = args; return { number: 4, url: 'https://gh/pull/4' }; },
    });
    assert.equal(r.ok, true);
    assert.equal(seen.cutFrom, 'main', 'cut from main, not stage');
    assert.deepEqual(seen.created, ['fix/self-repair-x', 'MAINSHA']);
    assert.equal(seen.pr.base, 'stage', 'the PR goes into stage');
  });
});
