import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Coverage for the autonomous-recovery redesign (2026-09-06, revised same
// day): the FIRST version of this fix blocked a recommendation for a human
// the moment ship-pacing's convergence cap (MAX_FAILED_ATTEMPTS = 3) was
// crossed. That made NEEDS_HUMAN the default outcome of any repeated
// ITEM_DEFECT failure, which is backwards for an autonomous system — 3
// identical retries only prove that retrying the SAME frozen params doesn't
// converge, not that the issue is unfixable. shipRecommendation always
// drafts against `rec.params`, captured whenever the finding was first
// detected (routes/action-center.js), and nothing ever refreshed it between
// retries — every attempt reproduced the identical stale anchor by
// construction.
//
// So crossing the cap now triggers a RECOVERY cycle instead: re-detect the
// finding against live content (reusing recheckRecommendation's existing
// primitive, the same one behind the manual "Re-check now" button, with its
// new refreshEvidence option) and refresh the recommendation's params, so
// the next generated draft targets reality instead of stale evidence. Each
// recovery cycle earns the finding a full new MAX_FAILED_ATTEMPTS worth of
// tries (ship-pacing's effectiveConvergenceCap). Only once MAX_RECOVERY_CYCLES
// of these have ALSO been exhausted does NEEDS_HUMAN become the answer — the
// true "cannot safely determine or validate a fix autonomously" fallback,
// not the first stall.
//
// Same fake-the-DB-by-SQL-shape style as store/recommendations.test.js.
// recheckRecommendation itself is mocked wholesale (its own behavior is
// covered by recommendation-coordinator-recheck.test.js) so these tests
// exercise only the reconciler's own decision: recover vs. block, and how
// many times recovery is tried before giving up.
let drafts;
let recs;
let recorded;
let recheckImpl;
let passOrder;

// Delegates to the real classifier rather than hand-copying its rules here —
// store/drafts.js's countFailedAttemptsByFinding used to carry its own
// independent SQL exclusion list, and that copy had already drifted from
// classifyAbandonReason's rules before it was deleted in favor of calling
// the classifier directly (see that function's own header comment). A
// SECOND hand-copied list in this test file would only reintroduce the same
// risk one level up.
const { classifyAbandonReason, RETRY_POLICY } = await import('./attempt-classification.js');
function countsFromDrafts() {
  const counts = new Map();
  for (const d of drafts) {
    if (d.status !== 'abandoned' || !d.abandoned_reason) continue;
    if (classifyAbandonReason(d.abandoned_reason).retryPolicy !== RETRY_POLICY.ITEM_DEFECT) continue;
    counts.set(d.finding_id, (counts.get(d.finding_id) || 0) + 1);
  }
  return counts;
}

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function fakeQuery(text, params = []) {
  const sql = normalize(text);

  // Pass 1 (reconcileStuckApprovedDrafts) — approved drafts stuck on a failed apply.
  if (sql.startsWith('SELECT id, finding_id, apply_error FROM drafts')) {
    const stuck = drafts.filter((d) => d.status === 'approved' && d.apply_error != null);
    return { rows: stuck.map((d) => ({ id: d.id, finding_id: d.finding_id, apply_error: d.apply_error })) };
  }
  // Pass 2 (reclaimStalledDrafts) — not under test here; always empty.
  if (sql.startsWith('SELECT id, finding_id, status, action_type, branch_name, updated_at FROM drafts')) {
    // Pass 2's stall-reclaim SELECT. Its position relative to pass 0 is the
    // whole point of that fix, so note when it runs.
    passOrder.push('stall-reclaim');
    return { rows: [] };
  }
  // Pass 3 (classifyUnrecordedFailures) — abandoned drafts with no attempt row yet.
  if (sql.startsWith('SELECT d.id, d.finding_id, d.abandoned_reason, d.abandoned_at FROM drafts d')) {
    const unrecorded = drafts.filter((d) => d.status === 'abandoned' && d.abandoned_reason && !d._attemptRecorded);
    return { rows: unrecorded.map((d) => ({ id: d.id, finding_id: d.finding_id, abandoned_reason: d.abandoned_reason, abandoned_at: d.abandoned_at || new Date() })) };
  }
  // getDraftByFindingId (store/drafts.js) — used by pass 4 to abandon a live
  // draft after a recovery refresh.
  if (sql.startsWith("SELECT * FROM drafts WHERE site_id = $1 AND finding_id = $2 AND status != 'abandoned'")) {
    const findingId = params[1];
    const live = drafts.find((d) => d.finding_id === findingId && d.status !== 'abandoned');
    return { rows: live ? [{ ...live }] : [] };
  }
  // countFailedAttemptsByFinding (store/drafts.js) — fetches raw rows now and
  // classifies them in JS, same as countsFromDrafts above does for this
  // test's own bookkeeping.
  if (sql.startsWith('SELECT finding_id, abandoned_reason FROM drafts')) {
    const abandoned = drafts.filter((d) => d.status === 'abandoned' && d.abandoned_reason);
    return { rows: abandoned.map((d) => ({ finding_id: d.finding_id, abandoned_reason: d.abandoned_reason })) };
  }
  // countRecoveryCyclesByFinding (store/recommendation-attempts.js).
  if (sql.startsWith("SELECT finding_id, COUNT(*)::int AS cycles FROM recommendation_attempts")) {
    const counts = new Map();
    for (const r of recorded) {
      if (r.outcome !== 'recovered' || !r.finding_id) continue;
      counts.set(r.finding_id, (counts.get(r.finding_id) || 0) + 1);
    }
    return { rows: [...counts.entries()].map(([finding_id, cycles]) => ({ finding_id, cycles })) };
  }
  if (sql.startsWith('SELECT id, status, blocked_reason FROM recommendations')) {
    const findingId = params[1];
    const rec = recs.find((r) => r.finding_id === findingId);
    return { rows: rec ? [{ id: rec.id, status: rec.status, blocked_reason: rec.blocked_reason || null }] : [] };
  }
  // listOpenRecommendations (store/recommendations.js), used by pass 4.
  if (sql.startsWith("SELECT * FROM recommendations WHERE site_id = $1 AND status = 'open'")) {
    return { rows: recs.filter((r) => r.status === 'open').map((r) => ({ ...r, finding_ids: r.finding_ids || [r.finding_id] })) };
  }
  if (sql.startsWith('INSERT INTO recommendation_attempts')) {
    const row = {
      site_id: params[0], recommendation_id: params[1], finding_id: params[2], draft_id: params[3],
      outcome: params[4], failure_class: params[5], retry_policy: params[6], reason: params[7],
    };
    recorded.push(row);
    const d = drafts.find((x) => x.id === params[3]);
    if (d) d._attemptRecorded = true;
    return { rows: [row] };
  }
  if (sql.startsWith("UPDATE drafts SET status = 'abandoned'")) {
    const [siteId, id, reason, abandonedBy] = params;
    const draft = drafts.find((d) => d.id === id && d.site_id === siteId);
    if (!draft || ['implemented', 'abandoned'].includes(draft.status)) return { rows: [] };
    draft.status = 'abandoned';
    draft.abandoned_reason = reason;
    draft.abandoned_by = abandonedBy;
    draft.apply_error = null;
    return { rows: [{ ...draft }] };
  }
  if (sql.startsWith('UPDATE recommendations SET execution_job_id = NULL')) {
    return { rows: [] };
  }
  if (sql.startsWith('UPDATE recommendations SET blocked_reason')) {
    const [id, reason, kind] = params;
    const rec = recs.find((r) => r.id === id);
    if (!rec || rec.status !== 'open') return { rows: [] };
    rec.blocked_reason = reason;
    rec.blocked_kind = kind;
    rec.risk_tier = 'manual';
    return { rows: [{ ...rec }] };
  }
  if (sql.startsWith("UPDATE recommendations SET status = 'superseded'")) {
    const id = params[0];
    const rec = recs.find((r) => r.id === id);
    if (rec) rec.status = 'superseded';
    return { rows: [] };
  }
  throw new Error(`action-center-reconciler.test.js fake query: unhandled SQL shape: ${sql}`);
}

const resolve = (p) => new URL(p, import.meta.url).href;
const { mock } = await import('node:test');
mock.module(resolve('../db.js'), {
  namedExports: { query: (text, params) => fakeQuery(text, params) },
});
mock.module(resolve('../agents/lib/recommendation-coordinator.js'), {
  namedExports: { recheckRecommendation: async (siteId, id, opts) => recheckImpl(siteId, id, opts) },
});
// Pass 0 is mocked wholesale for the same reason recheckRecommendation is:
// its own behavior has its own test file (batch-pr-recovery.test.js). What
// matters HERE is only that the reconciler runs it, and runs it BEFORE the
// stall reclaim — see the ordering test at the end of this file.
mock.module(resolve('./batch-pr-recovery.js'), {
  namedExports: {
    recoverUnopenedBatchPrs: async (siteId) => {
      passOrder.push('pr-recovery');
      return { branches: 0, opened: 0, adopted: 0, abandoned: 0, skipped: 0, details: [] };
    },
  },
});
const { reconcileSite } = await import('./action-center-reconciler.js');
const { MAX_RECOVERY_CYCLES, MAX_FAILED_ATTEMPTS } = await import('../agents/lib/ship-pacing.js');
const { NO_FILE_MAPPING_FRAGMENT } = await import('./draft-failure-phrases.js');

const SITE_ID = 1;
const ANCHOR_ERROR = (file) => `1 anchor(s) no longer found verbatim in ${file} — the source may have changed since this draft was generated.`;

// N abandoned drafts already on record for a finding, all pre-recorded
// (attemptSummaryByFinding/countFailedAttemptsByFinding already reflect them
// without this pass needing to do anything more).
function priorFailures(findingId, n, file = 'a.njk') {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: 1000 + i, site_id: SITE_ID, finding_id: findingId, status: 'abandoned', abandoned_reason: ANCHOR_ERROR(file), _attemptRecorded: true });
  }
  return out;
}

beforeEach(() => {
  drafts = [];
  recs = [];
  recorded = [];
  passOrder = [];
  recheckImpl = async () => { throw new Error('recheckRecommendation must not be called for this test'); };
});

describe('pass 4 (driveAutonomousRecovery) — below the cap: untouched, no re-detection at all', () => {
  test('a finding under MAX_FAILED_ATTEMPTS is left alone; recheckRecommendation is never called', async () => {
    drafts = priorFailures('f1', MAX_FAILED_ATTEMPTS - 1);
    recs = [{ id: 10, finding_id: 'f1', finding_ids: ['f1'], status: 'open', blocked_reason: null }];

    const result = await reconcileSite(SITE_ID, { apply: true });

    assert.equal(result.recovery.recommendations.length, 0);
    assert.equal(recs[0].blocked_reason, null);
  });
});

describe('pass 4 (driveAutonomousRecovery) — crossing the cap triggers autonomous recovery, not NEEDS_HUMAN', () => {
  test('ITEM_DEFECT at the cap re-detects against live content and regenerates instead of blocking', async () => {
    drafts = priorFailures('f2', MAX_FAILED_ATTEMPTS);
    recs = [{ id: 20, finding_id: 'f2', finding_ids: ['f2'], status: 'open', blocked_reason: null }];
    recheckImpl = async (siteId, id, opts) => {
      assert.equal(siteId, SITE_ID);
      assert.equal(id, 20);
      assert.deepEqual(opts, { refreshEvidence: true });
      return { status: 'open', changed: true, refreshed: true, freshParams: { page: 'x', anchor: 'FRESH' } };
    };

    const result = await reconcileSite(SITE_ID, { apply: true });

    assert.equal(result.recovery.recovered, 1);
    assert.equal(result.recovery.blocked, 0);
    assert.equal(recs[0].status, 'open');
    assert.equal(recs[0].blocked_reason, null, 'NEEDS_HUMAN must not be the default outcome of the first cap crossing');
    const recovered = recorded.find((r) => r.outcome === 'recovered');
    assert.ok(recovered, 'a distinct "recovered" attempt is recorded, not just another "failed" one');
    assert.equal(recovered.retry_policy, 'retry');
  });

  test('regression: a broken-link-fix recheck (recheckedLive: true, no refreshed/freshParams) still counts as a recovery cycle', async () => {
    // Without this, a permanently-dead external citation (DNS failure,
    // expired cert) never accumulates recovery cycles and never reaches
    // blockRecommendation — it loops here forever instead of ever
    // escalating to a human. broken-link-fix's recheckRecommendation branch
    // has no fresh params to report (the href doesn't change), so it can
    // only signal genuine live re-detection via recheckedLive.
    drafts = priorFailures('f2b', MAX_FAILED_ATTEMPTS);
    recs = [{ id: 21, finding_id: 'f2b', finding_ids: ['f2b'], status: 'open', blocked_reason: null }];
    recheckImpl = async () => ({ status: 'open', changed: false, recheckedLive: true, detail: { broken: true } });

    const result = await reconcileSite(SITE_ID, { apply: true });

    assert.equal(result.recovery.recovered, 1);
    assert.equal(result.recovery.blocked, 0);
    assert.equal(recs[0].blocked_reason, null);
    const recovered = recorded.find((r) => r.finding_id === 'f2b' && r.outcome === 'recovered');
    assert.ok(recovered, 'a broken-link-fix recheck without refreshed params must still record a recovery attempt');
  });

  test('abandons any live draft still sitting on the finding so the next attempt reads the refreshed params', async () => {
    drafts = priorFailures('f3', MAX_FAILED_ATTEMPTS);
    drafts.push({ id: 999, site_id: SITE_ID, finding_id: 'f3', status: 'draft' });
    recs = [{ id: 30, finding_id: 'f3', finding_ids: ['f3'], status: 'open', blocked_reason: null }];
    recheckImpl = async () => ({ status: 'open', changed: true, refreshed: true, freshParams: { x: 1 } });

    await reconcileSite(SITE_ID, { apply: true });

    assert.equal(drafts.find((d) => d.id === 999).status, 'abandoned');
  });

  test('the system does not stop at the first threshold: a second recovery cycle fires once the raised cap is also exhausted', async () => {
    // One recovery cycle already used, raising the cap to 2*MAX_FAILED_ATTEMPTS.
    // A fresh batch of failures since then has now exhausted that raised cap.
    drafts = priorFailures('f4', MAX_FAILED_ATTEMPTS * 2, 'b.njk');
    recs = [{ id: 40, finding_id: 'f4', finding_ids: ['f4'], status: 'open', blocked_reason: null }];
    recorded.push({ finding_id: 'f4', outcome: 'recovered' }); // one cycle already spent
    let recheckCalls = 0;
    recheckImpl = async () => { recheckCalls += 1; return { status: 'open', changed: true, refreshed: true, freshParams: { x: 2 } }; };

    const result = await reconcileSite(SITE_ID, { apply: true });

    assert.equal(recheckCalls, 1, 'a second, independent recovery cycle is attempted');
    assert.equal(result.recovery.recovered, 1);
    assert.equal(result.recovery.blocked, 0, 'still not exhausted — MAX_RECOVERY_CYCLES is 2, this is only the second');
    assert.equal(recs[0].blocked_reason, null);
  });
});

describe('pass 4 (driveAutonomousRecovery) — resolved on re-check', () => {
  test('recheckRecommendation closing the recommendation is respected — nothing further to recover', async () => {
    drafts = priorFailures('f5', MAX_FAILED_ATTEMPTS);
    recs = [{ id: 50, finding_id: 'f5', finding_ids: ['f5'], status: 'open', blocked_reason: null }];
    recheckImpl = async () => { recs[0].status = 'superseded'; return { status: 'superseded', changed: true }; };

    const result = await reconcileSite(SITE_ID, { apply: true });

    assert.equal(result.recovery.resolved, 1);
    assert.equal(result.recovery.blocked, 0);
    assert.equal(recs[0].status, 'superseded');
  });
});

describe('pass 4 (driveAutonomousRecovery) — NEEDS_HUMAN only once recovery is truly exhausted', () => {
  test('blocks only after MAX_RECOVERY_CYCLES independent recovery attempts have all failed identically', async () => {
    const cap = MAX_FAILED_ATTEMPTS * (MAX_RECOVERY_CYCLES + 1);
    drafts = priorFailures('f6', cap, 'c.njk');
    recs = [{ id: 60, finding_id: 'f6', finding_ids: ['f6'], status: 'open', blocked_reason: null }];
    for (let i = 0; i < MAX_RECOVERY_CYCLES; i++) recorded.push({ finding_id: 'f6', outcome: 'recovered' });

    const result = await reconcileSite(SITE_ID, { apply: true });

    assert.equal(result.recovery.blocked, 1);
    assert.equal(result.recovery.recovered, 0, 'no more autonomous attempts left to spend');
    assert.equal(recs[0].status, 'open', 'blocked stays open and visible, it does not close');
    assert.match(recs[0].blocked_reason, /autonomous re-analysis/);
    assert.match(recs[0].blocked_reason, new RegExp(`${MAX_RECOVERY_CYCLES} autonomous`));
  });

  test('never re-blocks or reprocesses an already-exhausted, already-blocked recommendation', async () => {
    const cap = MAX_FAILED_ATTEMPTS * (MAX_RECOVERY_CYCLES + 1);
    drafts = priorFailures('f7', cap, 'd.njk');
    recs = [{ id: 70, finding_id: 'f7', finding_ids: ['f7'], status: 'open', blocked_reason: null }];
    for (let i = 0; i < MAX_RECOVERY_CYCLES; i++) recorded.push({ finding_id: 'f7', outcome: 'recovered' });

    const first = await reconcileSite(SITE_ID, { apply: true });
    assert.equal(first.recovery.blocked, 1);

    const second = await reconcileSite(SITE_ID, { apply: true });
    assert.equal(second.recovery.blocked, 0, 'already blocked — never re-blocked, re-counted, or reprocessed');
  });
});

describe('pass 4 (driveAutonomousRecovery) — a failed recovery ATTEMPT never counts as a spent cycle', () => {
  test('a re-detection error is not counted, recorded, or blocked — retried next run instead', async () => {
    drafts = priorFailures('f8', MAX_FAILED_ATTEMPTS);
    recs = [{ id: 80, finding_id: 'f8', finding_ids: ['f8'], status: 'open', blocked_reason: null }];
    recheckImpl = async () => { throw new Error('upstream API timeout'); };

    const result = await reconcileSite(SITE_ID, { apply: true });

    assert.equal(result.recovery.recovered, 0);
    assert.equal(result.recovery.blocked, 0);
    assert.equal(recorded.find((r) => r.outcome === 'recovered'), undefined);
    assert.equal(recs[0].blocked_reason, null);
  });

  test('still detected but no fresh structured params to refresh — also not a spent cycle', async () => {
    drafts = priorFailures('f9', MAX_FAILED_ATTEMPTS);
    recs = [{ id: 90, finding_id: 'f9', finding_ids: ['f9'], status: 'open', blocked_reason: null }];
    recheckImpl = async () => ({ status: 'open', changed: false });

    const result = await reconcileSite(SITE_ID, { apply: true });

    assert.equal(result.recovery.recovered, 0);
    assert.equal(result.recovery.blocked, 0);
    assert.equal(recorded.find((r) => r.outcome === 'recovered'), undefined);
  });
});

describe('pass 4 (driveAutonomousRecovery) — dry run', () => {
  test('reports what it would do without calling recheckRecommendation or writing anything', async () => {
    drafts = priorFailures('f10', MAX_FAILED_ATTEMPTS);
    recs = [{ id: 100, finding_id: 'f10', finding_ids: ['f10'], status: 'open', blocked_reason: null }];
    recheckImpl = async () => { throw new Error('must not be called during a dry run'); };

    const result = await reconcileSite(SITE_ID, { apply: false });

    assert.equal(result.recovery.recommendations.length, 1);
    assert.equal(result.recovery.recovered, 0);
    assert.equal(result.recovery.blocked, 0);
    assert.equal(recs[0].blocked_reason, null);
  });
});

describe('pass 3 (classifyUnrecordedFailures) — ITEM_DEFECT is recorded but no longer decided here', () => {
  test('records the attempt but leaves blocking/recovery entirely to pass 4', async () => {
    drafts = [{ id: 1, site_id: SITE_ID, finding_id: 'g1', status: 'abandoned', abandoned_reason: ANCHOR_ERROR('a.njk') }];
    recs = [{ id: 200, finding_id: 'g1', finding_ids: ['g1'], status: 'open', blocked_reason: null }];

    const result = await reconcileSite(SITE_ID, { apply: true });

    assert.equal(result.failures.classified, 1);
    assert.equal(result.failures.blocked, 0);
    assert.equal(recs[0].status, 'open');
    assert.equal(recs[0].blocked_reason, null);
  });

  test('ALREADY_RESOLVED still closes the recommendation', async () => {
    drafts = [{ id: 111, site_id: SITE_ID, finding_id: 'g2', status: 'abandoned', abandoned_reason: 'This page already has an FAQPage schema from another draft — nothing left to publish.' }];
    recs = [{ id: 60, finding_id: 'g2', finding_ids: ['g2'], status: 'open', blocked_reason: null }];

    const result = await reconcileSite(SITE_ID, { apply: true });

    assert.equal(result.failures.resolved, 1);
    assert.equal(recs[0].status, 'superseded');
  });

  test('NEEDS_HUMAN still blocks the recommendation', async () => {
    drafts = [{ id: 112, site_id: SITE_ID, finding_id: 'g3', status: 'abandoned', abandoned_reason: NO_FILE_MAPPING_FRAGMENT }];
    recs = [{ id: 61, finding_id: 'g3', finding_ids: ['g3'], status: 'open', blocked_reason: null }];

    const result = await reconcileSite(SITE_ID, { apply: true });

    assert.equal(result.failures.blocked, 1);
    assert.equal(recs[0].status, 'open');
    assert.ok(recs[0].blocked_reason);
  });
});

describe('pass 1 (reconcileStuckApprovedDrafts) — abandons an ITEM_DEFECT approved+apply_error draft; the cap decision is not made here', () => {
  test('always abandons regardless of how many prior failures exist — no block, no willReachCap logic', async () => {
    drafts = [
      ...priorFailures('h1', 5, 'a.njk'),
      { id: 601, site_id: SITE_ID, finding_id: 'h1', status: 'approved', apply_error: ANCHOR_ERROR('a.njk') },
    ];
    recs = [{ id: 600, finding_id: 'h1', finding_ids: ['h1'], status: 'open', blocked_reason: null }];

    const result = await reconcileSite(SITE_ID, { apply: true });

    assert.equal(result.itemDefects.abandoned, 1);
    assert.equal(drafts.find((d) => d.id === 601).status, 'abandoned');
    // Whether it gets blocked or recovered is pass 4's decision, made after
    // this abandon — both are exercised in the pass-4 describe blocks above.
  });

  test('a RETRY-classified apply failure (e.g. a rate limit) is left retryable in place', async () => {
    drafts = [{ id: 801, site_id: SITE_ID, finding_id: 'h3', status: 'approved', apply_error: 'GitHub API rate limit exceeded, try again later' }];
    recs = [{ id: 800, finding_id: 'h3', finding_ids: ['h3'], status: 'open', blocked_reason: null }];

    const result = await reconcileSite(SITE_ID, { apply: true });

    assert.equal(result.itemDefects.drafts.length, 0);
    assert.equal(drafts[0].status, 'approved');
  });
});

// The ordering IS the fix. Pass 2 reclaims a 'branch_pushed' draft purely on
// lack of progress, and a batch whose commits landed but whose PR call failed
// is indistinguishable from one that never pushed — so running the reclaim
// first threw away real, pushed commits and regenerated them the next day,
// every day. Measured on site 1, 2026-09-08: 21 drafts, two branches, both
// with real commits ahead of main and one already carrying an open PR.
describe('pass 0 (batch-PR recovery) — ordering', () => {
  test('finishes already-pushed work BEFORE the stall reclaim is allowed to bin it', async () => {
    await reconcileSite(1, { apply: true, log: null });
    assert.equal(passOrder[0], 'pr-recovery', 'pass 0 must run first');
    assert.ok(passOrder.includes('stall-reclaim'));
    assert.ok(
      passOrder.indexOf('pr-recovery') < passOrder.indexOf('stall-reclaim'),
      'a reclaim that runs first destroys the very work pass 0 exists to finish',
    );
  });
});
