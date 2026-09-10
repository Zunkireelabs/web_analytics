import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let issued;

let implementedFindingIdsRows = [];
let pendingDraftFilePathsRows = [];
let unresolvedPriorBatchRows = [];
let countFailedAttemptsRows = [];
let insertDraftConflict = null; // set to a fake draft row to simulate a 23505 race on the next INSERT
let insertDraftErrorConstraint = 'drafts_site_finding_id_unique';

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  issued.push({ sql, params });
  if (sql.startsWith("UPDATE drafts SET status = 'branch_pushed'")) {
    return { rows: [{ id: params[1], status: 'branch_pushed' }] };
  }
  if (sql.startsWith('SELECT DISTINCT d.finding_id')) {
    return { rows: implementedFindingIdsRows };
  }
  if (sql.startsWith('SELECT DISTINCT target_file_path FROM drafts')) {
    return { rows: pendingDraftFilePathsRows };
  }
  if (sql.startsWith('SELECT branch_name, pr_number, pr_url, status')) {
    return { rows: unresolvedPriorBatchRows };
  }
  if (sql.startsWith('SELECT COUNT(*)::int AS n FROM drafts WHERE site_id = $1 AND action_type = ANY')) {
    return { rows: [{ n: 0 }] };
  }
  if (sql.startsWith('SELECT DISTINCT COALESCE(content')) {
    return { rows: [] };
  }
  if (sql.startsWith('SELECT 1 FROM drafts')) {
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO drafts')) {
    if (insertDraftConflict) {
      const err = new Error('duplicate key value violates unique constraint "drafts_site_finding_id_unique"');
      err.code = '23505';
      err.constraint = insertDraftErrorConstraint;
      throw err;
    }
    return { rows: [{ id: 1, site_id: params[0], action_type: params[1], finding_id: params[6] }] };
  }
  if (sql.startsWith('SELECT * FROM drafts WHERE site_id = $1 AND finding_id = $2')) {
    return { rows: insertDraftConflict ? [insertDraftConflict] : [] };
  }
  if (sql.startsWith('SELECT finding_id, abandoned_reason')) {
    return { rows: countFailedAttemptsRows };
  }
  throw new Error(`drafts.test.js fake query: unhandled SQL shape: ${sql}`);
}

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../db.js'), {
  namedExports: { query: (text, params) => fakeQuery(text, params) },
});
const {
  markDraftBranchPushed, getImplementedFindingIds,
  countVisibleFaqDrafts, distinctVisibleFaqDraftPages, hasImplementedVisibleFaqForPage,
  createDraft, getPendingDraftFilePaths, getUnresolvedPriorBatchBranch,
} = await import('./drafts.js');

beforeEach(() => { issued = []; implementedFindingIdsRows = []; pendingDraftFilePathsRows = []; unresolvedPriorBatchRows = []; insertDraftConflict = null; insertDraftErrorConstraint = 'drafts_site_finding_id_unique'; });

// Prompt 7 audit / migration 118: the app-level getDraftByFindingId-then-
// insert check in generateDraft() has a real concurrent window (LLM
// generation + Quality Gate + Design Agent resolution all run between the
// read and this insert) — the DB-level unique index is the actual
// backstop. This proves createDraft() treats a losing insert as "someone
// else already created this finding's draft," returning that row, rather
// than surfacing a raw duplicate-key error to the caller.
describe('createDraft — finding_id race backstop (migration 118)', () => {
  test('a normal insert with no conflict just returns the new row', async () => {
    const draft = await createDraft(7, { actionType: 'meta-title', findingId: 'analyst:gsc_ctr:trend_shift:2026-08-18:https://x.com/p', content: {} });
    assert.equal(draft.id, 1);
    assert.equal(draft.finding_id, 'analyst:gsc_ctr:trend_shift:2026-08-18:https://x.com/p');
  });

  test('a 23505 on drafts_site_finding_id_unique returns the winning concurrent draft instead of throwing', async () => {
    insertDraftConflict = { id: 42, site_id: 7, action_type: 'meta-title', finding_id: 'analyst:gsc_ctr:trend_shift:2026-08-18:https://x.com/p', status: 'draft' };
    const draft = await createDraft(7, { actionType: 'meta-title', findingId: 'analyst:gsc_ctr:trend_shift:2026-08-18:https://x.com/p', content: {} });
    assert.equal(draft.id, 42, 'returns the row the winning concurrent insert already created');
  });

  test('a 23505 on an UNRELATED constraint still throws — this backstop only swallows its own race', async () => {
    insertDraftConflict = { id: 99, site_id: 7, finding_id: 'analyst:gsc_ctr:trend_shift:2026-08-18:https://x.com/p' };
    insertDraftErrorConstraint = 'drafts_pkey';
    await assert.rejects(
      () => createDraft(7, { actionType: 'meta-title', findingId: 'analyst:gsc_ctr:trend_shift:2026-08-18:https://x.com/p', content: {} }),
      /duplicate key/,
    );
  });
});

// getImplementedFindingIds feeds Website Health's implementedFindingIds
// (job.js -> health-score.js) as well as Growth report/summary — a finding
// this excludes is treated everywhere as still-broken, not just "not shown
// in the Drafts tab". The actual still-present exclusion happens in
// Postgres (the LATERAL join + COALESCE), which a query-text fake can't
// execute — so this only asserts the query is shaped to do that filtering,
// plus that whatever rows come back become the returned Set.
describe('getImplementedFindingIds — verification-aware', () => {
  test('query excludes a finding whose latest real re-check still found the issue present', async () => {
    await getImplementedFindingIds(7);
    const select = issued.find((q) => q.sql.startsWith('SELECT DISTINCT d.finding_id'));
    assert.ok(select, 'issues the finding_id query');
    assert.match(select.sql, /LEFT JOIN LATERAL/);
    assert.match(select.sql, /fv\.site_id = d\.site_id AND fv\.finding_id = d\.finding_id/);
    assert.match(select.sql, /COALESCE\(latest_verification\.outcome, 'verified-fixed'\) != 'still-present'/);
    assert.equal(select.params[0], 7);
  });

  test('returns a Set built from whatever finding_ids the (already-filtered) query returns', async () => {
    implementedFindingIdsRows = [{ finding_id: 'security-headers:hsts' }, { finding_id: 'content-gap:/pricing:Missing FAQ' }];
    const result = await getImplementedFindingIds(7);
    assert.deepEqual(result, new Set(['security-headers:hsts', 'content-gap:/pricing:Missing FAQ']));
  });
});

// The file-level sibling to getDraftedFindingIds: a second day's Action
// Center batch must not regenerate a file that already has an earlier
// finding's draft sitting on a still-open, unmerged PR (batchBranchName,
// github-ops.js, forks a fresh branch every day regardless of whether
// yesterday's PR merged — confirmed live as a title flip-flopping across two
// unmerged PRs and a duplicate FAQ schema block).
describe('getPendingDraftFilePaths', () => {
  test('query is scoped to pr_opened/pr_state=open, non-null target_file_path, not rolled back', async () => {
    await getPendingDraftFilePaths(7);
    const q = issued.find((q) => q.sql.startsWith('SELECT DISTINCT target_file_path FROM drafts'));
    assert.ok(q, 'expected the pending-draft-file-paths query to run');
    assert.match(q.sql, /target_file_path IS NOT NULL/);
    assert.match(q.sql, /status = 'pr_opened'/);
    assert.match(q.sql, /pr_state = 'open'/);
    assert.match(q.sql, /rolled_back_at IS NULL/);
    assert.equal(q.params[0], 7);
  });

  test('returns a Set of the distinct file paths the query returns', async () => {
    pendingDraftFilePathsRows = [{ target_file_path: 'src/pages/index.njk' }, { target_file_path: 'src/blog/state-of-ai-nepal-2026.md' }];
    const result = await getPendingDraftFilePaths(7);
    assert.deepEqual(result, new Set(['src/pages/index.njk', 'src/blog/state-of-ai-nepal-2026.md']));
  });

  test('an empty result set is an empty Set, not undefined/null', async () => {
    const result = await getPendingDraftFilePaths(7);
    assert.deepEqual(result, new Set());
  });
});

// The BATCH-level sibling of getPendingDraftFilePaths: closes the gap that
// let action-center/batch-1-2026-09-07's delayed merge collide with
// action-center/batch-1-2026-09-08 (see github-ops.js's checkBatchSequencing).
describe('getUnresolvedPriorBatchBranch', () => {
  test('query excludes today\'s own branch, scopes to this site\'s batch- prefix, and checks both unresolved shapes', async () => {
    await getUnresolvedPriorBatchBranch(7, 'action-center/batch-7-2026-09-10');
    const q = issued.find((q) => q.sql.startsWith('SELECT branch_name, pr_number, pr_url, status'));
    assert.ok(q, 'expected the unresolved-prior-batch query to run');
    assert.match(q.sql, /branch_name LIKE \$2/);
    assert.match(q.sql, /branch_name <> \$3/);
    assert.match(q.sql, /status = 'pr_opened' AND pr_state = 'open'/);
    assert.match(q.sql, /status = 'branch_pushed' AND pr_number IS NULL/);
    assert.equal(q.params[0], 7);
    assert.equal(q.params[1], 'action-center/batch-7-%');
    assert.equal(q.params[2], 'action-center/batch-7-2026-09-10');
  });

  test('returns null when no unresolved prior branch exists', async () => {
    const result = await getUnresolvedPriorBatchBranch(7, 'action-center/batch-7-2026-09-10');
    assert.equal(result, null);
  });

  test('returns the row when an earlier day still has an open PR', async () => {
    unresolvedPriorBatchRows = [{ branch_name: 'action-center/batch-7-2026-09-09', pr_number: 86, pr_url: 'https://github.com/x/y/pull/86', status: 'pr_opened' }];
    const result = await getUnresolvedPriorBatchBranch(7, 'action-center/batch-7-2026-09-10');
    assert.equal(result.branch_name, 'action-center/batch-7-2026-09-09');
    assert.equal(result.pr_url, 'https://github.com/x/y/pull/86');
  });
});

// target_provenance carries page-resolution.js's resolvePageSource() output
// for the draft's target — recorded at the one point a draft's real GitHub
// branch actually gets pushed, so a reviewer can see what the change affects
// (a shared template's whole family, or just the one page) without having to
// re-derive it from the diff.
describe('markDraftBranchPushed — target_provenance', () => {
  test('persists provenance as JSONB alongside the existing branch-pushed fields', async () => {
    const provenance = { kind: 'generated-record', isSharedTemplate: true, affectedUrls: 'family' };
    await markDraftBranchPushed(1, 42, { branchName: 'auto/42', implementerId: 'backend', targetProvenance: provenance });

    const update = issued.find((q) => q.sql.includes("status = 'branch_pushed'"));
    assert.ok(update);
    assert.match(update.sql, /target_provenance = COALESCE\(\$7::jsonb, target_provenance\)/);
    assert.equal(update.params[6], JSON.stringify(provenance));
  });

  test('a null provenance leaves the column as COALESCE would — no write, not an error', async () => {
    await markDraftBranchPushed(1, 42, { branchName: 'auto/42', implementerId: 'backend' });
    const update = issued.find((q) => q.sql.includes("status = 'branch_pushed'"));
    assert.equal(update.params[6], null, 'COALESCE($7, target_provenance) with a null $7 preserves whatever was already stored');
  });

  test('appliedFiles and target_provenance are independent — passing one does not require the other', async () => {
    await markDraftBranchPushed(1, 42, {
      branchName: 'auto/42', implementerId: 'backend', appliedFiles: ['src/a.njk'], targetProvenance: null,
    });
    const update = issued.find((q) => q.sql.includes("status = 'branch_pushed'"));
    assert.equal(update.params[5], JSON.stringify(['src/a.njk']));
    assert.equal(update.params[6], null);
  });
});

// qa-content.js renders the same kind of visible accordion block 'faq' does
// (render-inspector.js's INSPECTABLE_ACTION_TYPES), so it shares the same
// sitewide visible-FAQ cap/dedup — a page that already has a visible FAQ
// from EITHER mechanism must not get a second one from the other. Regression
// coverage for the bug this closes: qa-content added a duplicate visible FAQ
// to a page that already had one, because these three queries only ever
// looked for action_type = 'faq', never noticing qa-content's own visible
// blocks (or vice versa).
describe('visible-FAQ cap/dedup queries cover both faq and qa-content', () => {
  test('countVisibleFaqDrafts filters on both action types, not just faq', async () => {
    await countVisibleFaqDrafts(1);
    const q = issued.find((q) => q.sql.includes('COUNT(*)::int AS n FROM drafts'));
    assert.ok(q, 'expected the count query to run');
    assert.deepEqual(q.params[1], ['faq', 'qa-content']);
  });

  test('distinctVisibleFaqDraftPages filters on both action types', async () => {
    await distinctVisibleFaqDraftPages(1);
    const q = issued.find((q) => q.sql.startsWith('SELECT DISTINCT COALESCE(content'));
    assert.ok(q);
    assert.deepEqual(q.params[1], ['faq', 'qa-content']);
  });

  test('hasImplementedVisibleFaqForPage filters on both action types', async () => {
    await hasImplementedVisibleFaqForPage(1, 'https://example.com/x');
    const q = issued.find((q) => q.sql.startsWith('SELECT 1 FROM drafts'));
    assert.ok(q);
    assert.deepEqual(q.params[2], ['faq', 'qa-content']);
  });

  // Regression for the actual production incident (zunkireelabs.com's index
  // page): drafts #113 (qa-content) and #114 (faq) were both approved within
  // ~90s of each other in the same daily batch, but neither reached
  // status='implemented' until the batch PR merged ~2.5h later. A query
  // gated on status='implemented' can never see an in-flight sibling at
  // decision time, however same-page/same-cap-pool it is — this asserts the
  // query no longer filters on that status at all, only on render_mode plus
  // the two "this draft's visible publish was actually undone" cases.
  test('hasImplementedVisibleFaqForPage does not require status=implemented — an in-flight sibling still counts', async () => {
    await hasImplementedVisibleFaqForPage(1, 'https://example.com/x');
    const q = issued.find((q) => q.sql.startsWith('SELECT 1 FROM drafts'));
    assert.ok(q);
    assert.doesNotMatch(q.sql, /status = 'implemented'/);
    assert.match(q.sql, /status <> 'abandoned'/);
    assert.match(q.sql, /rolled_back_at IS NULL/);
  });
});

// The convergence cap must only count failures that mean "this ITEM cannot be
// fixed". Counting anything else retires findings that have nothing wrong with
// them — which happened for real: on 2026-09-01 the two analytics findings sat
// at 15 and 12 attempts and were therefore held, even though both were by then
// ready to ship. 19 of those 27 were "No markers configured", a config gap a
// human had already closed. The cap would have permanently suppressed exactly
// the work that had just been made possible.
describe('countFailedAttemptsByFinding — what must never count as an item failure', () => {
  beforeEach(() => { issued = []; countFailedAttemptsRows = []; });

  // The exclusion logic itself now lives in attempt-classification.js's
  // classifyAbandonReason (RETRY_POLICY.ITEM_DEFECT is the only policy this
  // function counts) — this file's own job is just fetching the raw rows and
  // delegating. These tests exercise that delegation with real abandon-reason
  // strings/codes, not the old hand-maintained SQL exclusion list, which had
  // already drifted from classifyAbandonReason's rules before it was removed
  // (see this function's own header comment for the two concrete gaps that
  // drift produced live on site 1).
  const countFor = async (rows) => {
    countFailedAttemptsRows = rows;
    const { countFailedAttemptsByFinding } = await import('./drafts.js');
    return countFailedAttemptsByFinding(1);
  };

  test('config gaps a human can close are excluded — the item becomes eligible the moment they do', async () => {
    const m = await countFor([
      { finding_id: 'f1', abandoned_reason: 'Auto-ship failed: No markers configured for "/pricing" — add e.g. {"faq":"SEOAI:FAQ"} to url_file_map.pages[...].placements.' },
      { finding_id: 'f1', abandoned_reason: 'Auto-ship failed: No url_file_map entry matches "/pricing".' },
      { finding_id: 'f1', abandoned_reason: 'no-insertion-marker' },
      { finding_id: 'f1', abandoned_reason: 'no-file-mapping' },
    ]);
    assert.equal(m.has('f1'), false);
  });

  // The opposite of the case above: this one recurs identically FOREVER
  // unless a human hand-edits the draft (trust-compliance.js files the
  // finding specifically so they can) — no config change ever resolves it on
  // its own. That IS the per-item "cannot be auto-completed" signal the
  // convergence cap exists to catch, so — unlike the config gaps above — it
  // counts.
  test('an unverified-placeholder failure DOES count — nothing resolves it automatically', async () => {
    const m = await countFor([
      { finding_id: 'f1', abandoned_reason: 'Auto-ship failed: refusing to publish an unverified placeholder field' },
    ]);
    assert.equal(m.get('f1'), 1);
  });

  test('human decisions and bookkeeping are excluded — neither is a verdict on the item', async () => {
    const m = await countFor([
      { finding_id: 'f1', abandoned_reason: 'pr_closed_without_merge' },
      { finding_id: 'f1', abandoned_reason: 'sent_back_to_recommendations' },
      { finding_id: 'f1', abandoned_reason: 'Recovered: stranded at submitted_for_approval by the pre-fix swallow-and-strand gap (2026-08-25).' },
      { finding_id: 'f1', abandoned_reason: 'Stuck at "branch_pushed" and not resumable — abandoned so a fresh draft can be generated.' },
    ]);
    assert.equal(m.has('f1'), false);
  });

  test('infrastructure failures that hit every pending item at once are excluded', async () => {
    const m = await countFor([
      { finding_id: 'f1', abandoned_reason: 'rate limit exceeded, retry later' },
      { finding_id: 'f1', abandoned_reason: 'Batch push/PR failed: This pull request could not be opened right now — our team has been notified. (ref: abc123)' },
      { finding_id: 'f1', abandoned_reason: "Auto-ship failed: Today's batch branch (action-center/batch-1-2026-08-30) has diverged from main." },
    ]);
    assert.equal(m.has('f1'), false);
  });

  // Real incident, 2026-09-07: this exact string was counted as a per-item
  // defect by the old SQL list (no exclusion for it existed at all), which
  // wrongly retired 11 findings at the convergence cap on drafts that had
  // never actually failed on their own merits — the outage was in
  // infrastructure (a duplicate, unmanaged app container racing the real
  // deploy with no GITHUB_PAT in its environment), not in any of those items.
  test('a GitHub-credentials outage is excluded — it says nothing about the item', async () => {
    const m = await countFor([
      { finding_id: 'f1', abandoned_reason: 'Auto-ship failed: No GitHub PAT set in env var "GITHUB_PAT"' },
    ]);
    assert.equal(m.has('f1'), false);
  });

  // Real incident, 2026-09-01/2026-09-07: an item-specific defect (a schema
  // mismatch, an anchor no longer found) DOES still count — only the reasons
  // that say nothing about the item are excused, and this proves the fix
  // didn't quietly stop counting real defects too.
  test('a genuine item-specific defect still counts', async () => {
    const m = await countFor([
      { finding_id: 'f1', abandoned_reason: 'Auto-ship failed: 1 anchor(s) no longer found verbatim in src/pages/about.njk — the source may have changed.' },
      { finding_id: 'f1', abandoned_reason: 'invalid-edit' },
    ]);
    assert.equal(m.get('f1'), 2);
  });

  test('the count is windowed, so long-dead failures under changed code do not retire a finding forever', async () => {
    await countFor([{ finding_id: 'f1', abandoned_reason: 'invalid-edit' }]);
    const { sql } = issued.find((i) => i.sql.startsWith('SELECT finding_id, abandoned_reason'));
    assert.match(sql, /abandoned_at > now\(\) - interval '30 days'/);
  });

  test('returns a Map of finding_id -> attempts', async () => {
    const m = await countFor([
      { finding_id: 'f1', abandoned_reason: 'invalid-edit' },
      { finding_id: 'f1', abandoned_reason: 'invalid-edit' },
      { finding_id: 'f1', abandoned_reason: 'invalid-edit' },
      { finding_id: 'f1', abandoned_reason: 'invalid-edit' },
      { finding_id: 'f2', abandoned_reason: 'pr_closed_without_merge' },
    ]);
    assert.equal(m.get('f1'), 4);
    assert.equal(m.has('f2'), false);
  });
});
