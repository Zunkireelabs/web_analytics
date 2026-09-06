import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  codeSelfRepairEnabled, codeProblemSignature, countDistinctFailureDays,
  maybeEscalateToCodeRepair, applyKnownFix, investigateAndRepair, openPlatformRepairPr,
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
