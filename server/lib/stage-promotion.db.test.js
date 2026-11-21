import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { promoteMergedStageBatches, runStagePromotionForAllSites } from './stage-promotion.js';

// Real Postgres for the bookkeeping SQL; GitHub is faked with the SAME shapes the real client returns:
//   getPullRequest -> { state, merged, mergeable, mergeableState }   listOpenPullRequestsForBranch -> [{ number, html_url, base: { ref } }]
//   openPullRequest -> { number, url }                               checkClientBuildStatus -> { ok: true } | { ok: false, reason, error }
const TAG = `sp${Date.now()}`;
const siteIds = []; const wsIds = [];
async function seedSite(label, { stage = 'stage' } = {}) {
  const ws = (await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`WS-${label}-${TAG}`])).rows[0].id; wsIds.push(ws);
  const id = (await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain, onboarded_at, status, repo_owner, repo_name, repo_default_branch, pr_target_branch)
     VALUES ($1,$2,$2,'UTC',$3,$4, now(), 'active', 'acme', $5, 'main', $6) RETURNING id`,
    [`Proj-${label}-${TAG}`, `sc-${label}-${TAG}`, ws, `${label}.${TAG}.example`, `repo-${label}`, stage])).rows[0].id;
  siteIds.push(id); return id;
}
const draftOnPr = (siteId, pr, { status = 'pr_opened', base = 'stage', type = 'landing-page' } = {}) => query(
  `INSERT INTO drafts (site_id, action_type, source, input, content, status, branch_name, pr_number, pr_url, pr_state, pr_base_branch)
   VALUES ($1,$2,'auto-remediation','{}'::jsonb,'{}'::jsonb,$3,$4,$5,$6,'open',$7)`,
  [siteId, type, status, `action-center/batch-${siteId}-${pr}`, pr, `https://github.com/acme/repo/pull/${pr}`, base]);
const rows = async (siteId) => (await query(`SELECT source_pr_number, status, promotion_pr_number FROM stage_promotions WHERE site_id = $1 ORDER BY source_pr_number`, [siteId])).rows;

const make = ({ merged = {}, build = { ok: true }, open = [], built = null } = {}) => {
  const log = { opened: [], built: [] };
  return {
    log,
    deps: {
      readPr: async (_s, n) => ({ state: merged[n] ? 'closed' : 'open', merged: Boolean(merged[n]), mergeable: null, mergeableState: null, mergeSha: `M${n}`, mergedAt: `2026-01-${String(n % 28 + 1).padStart(2, '0')}T00:00:00Z`, title: `PR ${n}`, url: `https://github.com/acme/repo/pull/${n}` }),
      buildStatus: async () => build,
      listOpen: async () => open,
      // The promotion branch is built by lib/promotion-branch.js (tested on its own); here it replays every batch it is given.
      buildBranch: async (_s, args) => {
        log.built.push(args);
        return built ? built(args) : { ok: true, noChange: false, branch: args.branchName, applied: args.prs.map((p) => ({ number: p.number, url: p.url })), skipped: [] };
      },
      now: () => new Date('2026-11-21T10:00:00Z'),
      openPr: async (_s, args) => { log.opened.push(args); return { number: 500 + log.opened.length, url: `https://github.com/acme/repo/pull/${500 + log.opened.length}` }; },
    },
  };
};

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM stage_promotions WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM drafts WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  if (wsIds.length) await query('DELETE FROM workspaces WHERE id = ANY($1::int[])', [wsIds]);
  await pool.end();
});

describe('stage -> main promotion', () => {
  test('a client without a stage branch is skipped', async () => {
    const id = await seedSite('nostage', { stage: '' });
    const { deps, log } = make();
    const r = await promoteMergedStageBatches(id, deps);
    assert.equal(r.reason, 'no-stage-branch'); assert.equal(log.opened.length, 0);
  });

  test('a stage PR nobody has merged yet opens nothing', async () => {
    const id = await seedSite('open'); await draftOnPr(id, 10);
    const { deps, log } = make({ merged: {} });
    const r = await promoteMergedStageBatches(id, deps);
    assert.equal(r.reason, 'nothing-merged-on-stage'); assert.equal(log.opened.length, 0); assert.deepEqual(await rows(id), []);
  });

  test('a merged stage PR opens ONE promotion PR for what a person merged, and only once', async () => {
    const id = await seedSite('merged'); await draftOnPr(id, 10); await draftOnPr(id, 10, { type: 'schema-repair' }); await draftOnPr(id, 11);
    const { deps, log } = make({ merged: { 10: true } });
    const r = await promoteMergedStageBatches(id, deps);
    assert.equal(log.opened.length, 1);
    assert.notEqual(log.opened[0].branch, 'stage', 'the promotion is never stage itself');
    assert.match(log.opened[0].branch, /^promote\/stage-20261121-10$/); assert.equal(log.opened[0].base, 'main');
    assert.deepEqual(log.built[0].prs.map((p) => p.number), [10], 'only the batch a person merged is replayed onto a fresh main branch');
    assert.equal(log.built[0].main, 'main');
    assert.match(log.opened[0].body, /fresh branch cut from the latest `main`/);
    assert.match(log.opened[0].body, /pull\/10/); assert.doesNotMatch(log.opened[0].body, /pull\/11/, 'only the merged batch is listed');
    assert.match(log.opened[0].body, /never merges/);
    assert.deepEqual(r.opened, { number: 501, url: 'https://github.com/acme/repo/pull/501' });
    assert.deepEqual(await rows(id), [{ source_pr_number: 10, status: 'opened', promotion_pr_number: 501 }]);
    const again = await promoteMergedStageBatches(id, deps);
    assert.equal(log.opened.length, 1, 'a second run must not open a second PR'); assert.equal(again.reason, 'nothing-merged-on-stage');
  });

  test('two merged batches are promoted together in one PR', async () => {
    const id = await seedSite('two'); await draftOnPr(id, 20); await draftOnPr(id, 21);
    const { deps, log } = make({ merged: { 20: true, 21: true } });
    await promoteMergedStageBatches(id, deps);
    assert.equal(log.opened.length, 1); assert.match(log.opened[0].body, /pull\/20/); assert.match(log.opened[0].body, /pull\/21/);
    assert.deepEqual((await rows(id)).map((r) => r.promotion_pr_number), [501, 501]);
  });

  test('stage\'s build still running: waits, opens nothing, and opens it on a later run', async () => {
    const id = await seedSite('pending'); await draftOnPr(id, 30);
    const first = make({ merged: { 30: true }, build: { ok: false, reason: 'client-build-check-pending' } });
    const r = await promoteMergedStageBatches(id, first.deps);
    assert.equal(r.waiting, true); assert.equal(first.log.opened.length, 0); assert.equal((await rows(id))[0].status, 'waiting');
    const later = make({ merged: { 30: true }, build: { ok: true } });
    await promoteMergedStageBatches(id, later.deps);
    assert.equal(later.log.opened.length, 1); assert.equal((await rows(id))[0].status, 'opened');
  });

  test('stage\'s build failed: blocked, nothing opened', async () => {
    const id = await seedSite('failed'); await draftOnPr(id, 40);
    const { deps, log } = make({ merged: { 40: true }, build: { ok: false, reason: 'client-build-check-failed' } });
    const r = await promoteMergedStageBatches(id, deps);
    assert.equal(r.blocked, true); assert.equal(log.opened.length, 0); assert.equal((await rows(id))[0].status, 'blocked');
  });

  test('a repo with no build check yet is not blocked, and the PR says so', async () => {
    const id = await seedSite('nocheck'); await draftOnPr(id, 50);
    const { deps, log } = make({ merged: { 50: true }, build: { ok: false, reason: 'client-build-check-not-configured' } });
    await promoteMergedStageBatches(id, deps);
    assert.equal(log.opened.length, 1); assert.match(log.opened[0].body, /No automated build check/);
  });

  test('an already-open stage -> main PR is reused, never duplicated', async () => {
    const id = await seedSite('reuse'); await draftOnPr(id, 60);
    const { deps, log } = make({ merged: { 60: true }, open: [{ number: 9, html_url: 'https://github.com/acme/repo/pull/9', base: { ref: 'main' } }] });
    const r = await promoteMergedStageBatches(id, deps);
    assert.equal(log.opened.length, 0); assert.equal(r.reused, true); assert.deepEqual(r.opened, { number: 9, url: 'https://github.com/acme/repo/pull/9' });
    assert.deepEqual(await rows(id), [{ source_pr_number: 60, status: 'opened', promotion_pr_number: 9 }]);
  });

  test('an open PR from stage that does not target main is not mistaken for the promotion', async () => {
    const id = await seedSite('othbase'); await draftOnPr(id, 70);
    const { deps, log } = make({ merged: { 70: true }, open: [{ number: 3, html_url: 'x', base: { ref: 'release' } }] });
    await promoteMergedStageBatches(id, deps);
    assert.equal(log.opened.length, 1);
  });

  test('a draft whose PR went straight to main is never promoted', async () => {
    const id = await seedSite('direct'); await draftOnPr(id, 80, { base: 'main', type: 'refresh-content' });
    const { deps, log } = make({ merged: { 80: true } });
    const r = await promoteMergedStageBatches(id, deps);
    assert.equal(r.reason, 'nothing-merged-on-stage'); assert.equal(log.opened.length, 0);
  });

  test('a batch whose files main has moved past is held back with the reason, never forced into production', async () => {
    const id = await seedSite('heldback'); await draftOnPr(id, 100); await draftOnPr(id, 101);
    const { deps, log } = make({
      merged: { 100: true, 101: true },
      built: (args) => ({ ok: true, noChange: false, branch: args.branchName, applied: [{ number: 100, url: 'https://github.com/acme/repo/pull/100' }], skipped: [{ number: 101, reason: 'main-changed', detail: 'src/a.md' }] }),
    });
    const r = await promoteMergedStageBatches(id, deps);
    assert.equal(log.opened.length, 1);
    assert.match(log.opened[0].body, /Held back/); assert.match(log.opened[0].body, /#101 \(main-changed: `src\/a\.md`\)/);
    assert.deepEqual(r.heldBack.map((x) => x.number), [101]);
    const st = Object.fromEntries((await rows(id)).map((x) => [x.source_pr_number, x.status]));
    assert.deepEqual(st, { 100: 'opened', 101: 'blocked' });
  });

  test('when EVERYTHING is held back nothing is opened and a person is told why', async () => {
    const id = await seedSite('allheld'); await draftOnPr(id, 110);
    const { deps, log } = make({ merged: { 110: true }, built: () => ({ ok: true, noChange: true, branch: null, applied: [], skipped: [{ number: 110, reason: 'main-changed', detail: 'x.md' }] }) });
    const r = await promoteMergedStageBatches(id, deps);
    assert.equal(log.opened.length, 0); assert.equal(r.blocked, true); assert.equal(r.reason, 'promotion-held-back');
    assert.equal((await rows(id))[0].status, 'blocked');
  });

  test('a batch already on main needs no PR and is not retried forever', async () => {
    const id = await seedSite('onmain'); await draftOnPr(id, 120);
    const { deps, log } = make({ merged: { 120: true }, built: () => ({ ok: true, noChange: true, branch: null, applied: [], skipped: [] }) });
    const r = await promoteMergedStageBatches(id, deps);
    assert.equal(log.opened.length, 0); assert.equal(r.reason, 'already-on-main');
    assert.equal((await rows(id))[0].status, 'opened');
  });

  test('the all-sites run counts what it did, and one failing client does not stop the rest', async () => {
    const good = await seedSite('allgood'); await draftOnPr(good, 90);
    const bad = await seedSite('allbad'); await draftOnPr(bad, 91);
    const m = make({ merged: { 90: true, 91: true } });
    const deps = { ...m.deps, readPr: async (s, n) => { if (n === 91) throw new Error('boom'); return { state: 'closed', merged: true }; } };
    const totals = await runStagePromotionForAllSites(deps);
    assert.ok(totals.sites >= 2); assert.ok(totals.opened >= 1);
    assert.equal((await rows(good))[0].status, 'opened');
  });
});
