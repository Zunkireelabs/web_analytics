// The corrected stage -> main promotion, run WITHOUT a database: the three SQL statements it issues are answered by a
// small fake, and GitHub is faked with the real client's shapes. (stage-promotion.db.test.js covers the same flow against
// real Postgres in CI.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promoteMergedStageBatches } from './stage-promotion.js';

function harness({ batches = [], done = new Map(), merged = {}, build = { ok: true }, open = [], built = null, site = { id: 7, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', pr_target_branch: 'stage' } } = {}) {
  const log = { remembered: [], opened: [], built: [] };
  const query = async (sql, params) => {
    if (/FROM drafts WHERE site_id/.test(sql)) return { rows: batches };
    if (/FROM stage_promotions WHERE site_id/.test(sql)) return { rows: [...done].map(([source_pr_number, status]) => ({ source_pr_number, status })) };
    if (/INSERT INTO stage_promotions/.test(sql)) { log.remembered.push({ pr: params[1], status: params[2], number: params[3], note: params[5] }); return { rows: [] }; }
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  };
  return {
    log,
    deps: {
      query, loadSite: async () => site,
      readPr: async (_s, n) => ({ state: merged[n] ? 'closed' : 'open', merged: Boolean(merged[n]), mergeSha: `M${n}`, mergedAt: `2026-01-0${n % 9 + 1}`, title: `PR ${n}`, url: `https://gh/pull/${n}` }),
      buildStatus: async () => build, listOpen: async () => open,
      buildBranch: async (_s, args) => { log.built.push(args); return built ? built(args) : { ok: true, noChange: false, branch: args.branchName, applied: args.prs.map((p) => ({ number: p.number, url: p.url })), skipped: [] }; },
      openPr: async (_s, args) => { log.opened.push(args); return { number: 900 + log.opened.length, url: `https://gh/pull/${900 + log.opened.length}` }; },
      now: () => new Date('2026-11-21T10:00:00Z'),
    },
  };
}
const batch = (n) => ({ pr_number: n, draft_ids: [n], pr_url: `https://gh/pull/${n}`, undecided: false });

test('the promotion PR is a fresh branch from main with ONLY the merged batches — never stage itself', async () => {
  const h = harness({ batches: [batch(10), batch(11)], merged: { 10: true } });
  const r = await promoteMergedStageBatches(7, h.deps);
  assert.equal(h.log.opened.length, 1);
  assert.equal(h.log.opened[0].branch, 'promote/stage-20261121-10');
  assert.notEqual(h.log.opened[0].branch, 'stage');
  assert.equal(h.log.opened[0].base, 'main');
  assert.deepEqual(h.log.built[0].prs.map((p) => p.number), [10], 'the unmerged batch 11 is not replayed');
  assert.equal(h.log.built[0].main, 'main');
  assert.deepEqual(r.opened, { number: 901, url: 'https://gh/pull/901' });
  assert.match(h.log.opened[0].body, /fresh branch cut from the latest `main`/);
  assert.match(h.log.opened[0].body, /The agent never merges this for you/);
});

test('the branch name is fixed by what is promoted, so a repeat run reuses the open PR instead of opening another', async () => {
  const h = harness({ batches: [batch(10)], merged: { 10: true }, open: [{ number: 55, html_url: 'https://gh/pull/55', base: { ref: 'main' } }] });
  const r = await promoteMergedStageBatches(7, h.deps);
  assert.equal(h.log.opened.length, 0);
  assert.equal(h.log.built.length, 0, 'no second branch is built');
  assert.equal(r.reused, true);
});

test('two batches where one is held back: the PR opens with the safe one and names the other with the reason', async () => {
  const h = harness({
    batches: [batch(20), batch(21)], merged: { 20: true, 21: true },
    built: (args) => ({ ok: true, noChange: false, branch: args.branchName, applied: [{ number: 20, url: 'https://gh/pull/20' }], skipped: [{ number: 21, reason: 'main-changed', detail: 'src/a.md' }] }),
  });
  const r = await promoteMergedStageBatches(7, h.deps);
  assert.equal(h.log.opened.length, 1);
  assert.match(h.log.opened[0].body, /Held back/);
  assert.match(h.log.opened[0].body, /#21 \(main-changed: `src\/a\.md`\)/);
  const byPr = Object.fromEntries(h.log.remembered.map((x) => [x.pr, x.status]));
  assert.equal(byPr[20], 'opened');
  assert.equal(byPr[21], 'blocked');
  assert.deepEqual(r.heldBack.map((x) => x.number), [21]);
});

test('when every batch is held back nothing is opened — a person is told, and the batches are retried later', async () => {
  const h = harness({ batches: [batch(30)], merged: { 30: true }, built: () => ({ ok: true, noChange: true, branch: null, applied: [], skipped: [{ number: 30, reason: 'main-changed', detail: 'x.md' }] }) });
  const r = await promoteMergedStageBatches(7, h.deps);
  assert.equal(h.log.opened.length, 0);
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'promotion-held-back');
  assert.equal(h.log.remembered[0].status, 'blocked');
});

test('a batch already on main needs no PR and is recorded as done, not retried forever', async () => {
  const h = harness({ batches: [batch(40)], merged: { 40: true }, built: () => ({ ok: true, noChange: true, branch: null, applied: [], skipped: [] }) });
  const r = await promoteMergedStageBatches(7, h.deps);
  assert.equal(r.reason, 'already-on-main');
  assert.equal(h.log.remembered[0].status, 'opened');
});

test('stage\'s build still running or failed: nothing is built, nothing is opened', async () => {
  for (const [reason, flag] of [['client-build-check-pending', 'waiting'], ['client-build-check-failed', 'blocked']]) {
    const h = harness({ batches: [batch(50)], merged: { 50: true }, build: { ok: false, reason } });
    const r = await promoteMergedStageBatches(7, h.deps);
    assert.equal(r[flag], true, reason);
    assert.equal(h.log.built.length, 0);
    assert.equal(h.log.opened.length, 0);
  }
});

test('a client with no stage branch, or nothing merged yet, is left alone', async () => {
  const none = harness({ site: { id: 7, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', pr_target_branch: '' } });
  assert.equal((await promoteMergedStageBatches(7, none.deps)).reason, 'no-stage-branch');
  const nothing = harness({ batches: [batch(60)], merged: {} });
  assert.equal((await promoteMergedStageBatches(7, nothing.deps)).reason, 'nothing-merged-on-stage');
  assert.equal(nothing.log.built.length, 0);
});

test('already-promoted batches are skipped', async () => {
  const h = harness({ batches: [batch(70)], merged: { 70: true }, done: new Map([[70, 'opened']]) });
  assert.equal((await promoteMergedStageBatches(7, h.deps)).reason, 'nothing-merged-on-stage');
});

test('the agent never merges: no merge function is even in the promotion\'s reach', async () => {
  const h = harness({ batches: [batch(80)], merged: { 80: true } });
  await promoteMergedStageBatches(7, h.deps);
  assert.deepEqual(Object.keys(h.deps).filter((k) => /merge$/i.test(k) && k !== 'buildBranch'), []);
});
