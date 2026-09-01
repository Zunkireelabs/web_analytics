import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let issued;

let implementedFindingIdsRows = [];
let pendingDraftFilePathsRows = [];
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
  if (sql.startsWith('SELECT finding_id, COUNT(*)::int AS attempts')) {
    return { rows: [{ finding_id: 'f1', attempts: 4 }] };
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
  createDraft, getPendingDraftFilePaths,
} = await import('./drafts.js');

beforeEach(() => { issued = []; implementedFindingIdsRows = []; pendingDraftFilePathsRows = []; insertDraftConflict = null; insertDraftErrorConstraint = 'drafts_site_finding_id_unique'; });

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
  beforeEach(() => { issued = []; });

  const sqlFor = async () => {
    const { countFailedAttemptsByFinding } = await import('./drafts.js');
    await countFailedAttemptsByFinding(1);
    return issued.at(-1).sql;
  };

  test('config gaps a human can close are excluded — the item becomes eligible the moment they do', async () => {
    const sql = await sqlFor();
    assert.match(sql, /No markers configured/);
    assert.match(sql, /No url_file_map entry matches/);
    assert.match(sql, /unverified placeholder field/);
  });

  test('human decisions and bookkeeping are excluded — neither is a verdict on the item', async () => {
    const sql = await sqlFor();
    assert.match(sql, /pr_closed_without_merge/);
    assert.match(sql, /sent_back_to_recommendations/);
    assert.match(sql, /Recovered:/);
    assert.match(sql, /Stuck at/);
  });

  test('infrastructure failures that hit every pending item at once are excluded', async () => {
    const sql = await sqlFor();
    assert.match(sql, /rate limit/);
    assert.match(sql, /Batch push\/PR failed/);
    assert.match(sql, /batch branch.*diverged/);
  });

  test('the count is windowed, so long-dead failures under changed code do not retire a finding forever', async () => {
    assert.match(await sqlFor(), /abandoned_at > now\(\) - interval '30 days'/);
  });

  test('returns a Map of finding_id -> attempts', async () => {
    const { countFailedAttemptsByFinding } = await import('./drafts.js');
    const m = await countFailedAttemptsByFinding(1);
    assert.equal(m.get('f1'), 4);
  });
});
