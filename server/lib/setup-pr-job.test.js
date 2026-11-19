import test from 'node:test';
import assert from 'node:assert/strict';
import { runSetupPrsDue, runSetupPrForSite, notReadyReason, RETRY_AFTER_MS } from './setup-pr-job.js';

const NOW = new Date('2026-11-19T12:00:00Z');
// Shape of a real sites row for a project that is ready (fields as read by store/read.js getSiteById).
const ready = (over = {}) => ({ id: 8874, name: 'MOBILISE', status: 'active', repo_owner: 'mobilisecloud-admin', repo_name: 'mobilise-website-11ty',
  auto_remediation_enabled: true, onboarded_at: '2026-11-13T02:59:00Z', ...over });
const plan = (n = 2) => ({ files: Array.from({ length: n }, (_, i) => ({ path: `t${i}.njk`, added: ['CANONICAL', 'OPENGRAPH'] })), alreadyComplete: 0, unresolved: [], skipped: [], truncated: false, coverage: { ready: 5, partial: 1, unmapped: 0, unknown: 0 } });
const quiet = { log() {}, error() {} };

function harness(over = {}) {
  const calls = [];
  const state = { site: ready(), plan: plan(), opened: { ok: true, opened: false }, ...{} };
  state.opened = { ok: true, opened: true, prNumber: 7, prUrl: 'https://github.com/x/y/pull/7', branch: 'seoai/setup-markers-8874-2026-11-19' };
  const deps = {
    enabled: () => true,
    listDueSiteIds: async (now, limit) => { calls.push(`list:${limit}`); return state.due ?? [8874]; },
    getSite: async () => state.site,
    withLock: async (id, fn) => ({ ran: true, result: await fn() }),
    // the whole readiness pass: learn, complete the page list, map, plan, gate, design capture
    readiness: async () => { calls.push('readiness'); return { stack: 'Eleventy (11ty)', plan: state.plan, reason: state.readinessReason, summary: { ready: false, gate: { markersComplete: true } } }; },
    saveReadiness: async (id, summary) => { calls.push('saveReadiness'); state.readinessSaved = summary; },
    open: async (site, p, opts) => { calls.push(`open:${opts.stack}`); return state.opened; },
    recordDone: async (id, result) => { calls.push(`done:${result.status}`); state.done = result; },
    recordFailure: async (id, error, retryAt) => { calls.push(`fail:${error}`); state.failedAt = retryAt; },
    defer: async (id, reason, retryAt) => { calls.push(`defer:${reason}`); state.deferredAt = retryAt; },
    ...over,
  };
  return { deps, calls, state };
}

test('a ready project: the readiness pass first, its result stored, then the PR opened and recorded', async () => {
  const { deps, calls, state } = harness();
  const r = await runSetupPrForSite(8874, { now: NOW, deps, log: quiet });
  assert.deepEqual(calls, ['readiness', 'saveReadiness', 'open:Eleventy (11ty)', 'done:opened']);
  assert.equal(r.status, 'opened');
  assert.equal(state.done.prUrl, 'https://github.com/x/y/pull/7');
  assert.equal(state.done.files, 2);
  assert.equal(state.done.markers, 4);
});

test('not ready is deferred, never counted as a failure, and nothing is opened', async () => {
  for (const [over, reason] of [
    [{ auto_remediation_enabled: false }, /Auto-fixes is off/],
    [{ repo_owner: null }, /no GitHub repository/],
    [{ onboarded_at: null }, /baseline is not done/],
    [{ status: 'paused' }, /not active/],
  ]) {
    const h = harness(); h.state.site = ready(over);
    const r = await runSetupPrForSite(8874, { now: NOW, deps: h.deps, log: quiet });
    assert.equal(r.status, 'not-ready');
    assert.match(r.reason, reason);
    assert.deepEqual(h.calls.filter((c) => !c.startsWith('defer')), []);
    assert.ok(h.state.deferredAt > NOW);
  }
});

test('a missing design profile or a spend cap does not hold the PR: markers are comments, the job only asks readiness to QUEUE the capture', async () => {
  const site = ready({ design_profile: null }); // no profile at all
  assert.equal(notReadyReason(site), null);
  const h = harness(); h.state.site = site;
  assert.equal((await runSetupPrForSite(8874, { now: NOW, deps: h.deps, log: quiet })).status, 'opened');
});

test('nothing to add is a finished outcome, with the reason kept; no PR is opened', async () => {
  const h = harness(); h.state.plan = { ...plan(0), alreadyComplete: 3, unresolved: [{ path: 'a', markerName: 'TITLE', reason: 'no-front-matter' }] };
  const r = await runSetupPrForSite(8874, { now: NOW, deps: h.deps, log: quiet });
  assert.equal(r.status, 'nothing-to-add');
  assert.ok(!h.calls.some((c) => c.startsWith('open')));
  assert.equal(h.state.done.unresolved, 1);
});

test('an already open setup PR is recorded as done with its reason, not duplicated', async () => {
  const h = harness(); h.state.opened = { ok: true, opened: false, reason: 'already-open', prNumber: 4, prUrl: 'https://github.com/x/y/pull/4' };
  const r = await runSetupPrForSite(8874, { now: NOW, deps: h.deps, log: quiet });
  assert.equal(r.status, 'already-open');
  assert.equal(h.state.done.prNumber, 4);
});

test('a GitHub failure is recorded and retried in 30 minutes; the job never throws', async () => {
  const h = harness({ open: async () => { throw new Error('GitHub 502'); } });
  const r = await runSetupPrForSite(8874, { now: NOW, deps: h.deps, log: quiet });
  assert.equal(r.status, 'failed');
  assert.ok(h.calls.includes('fail:GitHub 502'));
  assert.equal(h.state.failedAt.getTime(), NOW.getTime() + RETRY_AFTER_MS);
});

test('a readiness failure is recorded and retried in 30 minutes; nothing is opened; the job never throws', async () => {
  const h = harness({ readiness: async () => { throw new Error('GitHub tree unavailable'); } });
  const r = await runSetupPrForSite(8874, { now: NOW, deps: h.deps, log: quiet });
  assert.equal(r.status, 'failed');
  assert.ok(h.calls.includes('fail:GitHub tree unavailable'));
  assert.ok(!h.calls.some((c) => c.startsWith('open')));
  assert.equal(h.state.failedAt.getTime(), NOW.getTime() + RETRY_AFTER_MS);
});

test('readiness saying the project has no repository is a deferral, not a failure', async () => {
  const h = harness(); h.state.readinessReason = 'no-repository-connected';
  const r = await runSetupPrForSite(8874, { now: NOW, deps: h.deps, log: quiet });
  assert.equal(r.status, 'not-ready');
  assert.ok(h.calls.includes('defer:not ready: no-repository-connected'));
});

test('a failure to STORE the readiness result does not stop the PR', async () => {
  const h = harness({ saveReadiness: async () => { throw new Error('db down'); } });
  const r = await runSetupPrForSite(8874, { now: NOW, deps: h.deps, log: quiet });
  assert.equal(r.status, 'opened');
});

test('the cron pass takes one project at a time, honours the off switch, and skips a locked project', async () => {
  const one = harness(); one.state.due = [8874];
  assert.equal((await runSetupPrsDue({ now: NOW, deps: one.deps, log: quiet })).ran, 1);
  assert.ok(one.calls.includes('list:1'));

  const off = harness({ enabled: () => false });
  assert.deepEqual(await runSetupPrsDue({ now: NOW, deps: off.deps, log: quiet }), { ran: 0, disabled: true, results: [] });
  assert.equal(off.calls.length, 0);

  const locked = harness({ withLock: async () => ({ ran: false }) });
  assert.equal((await runSetupPrsDue({ now: NOW, deps: locked.deps, log: quiet })).results[0].status, 'locked');
});

// ---- the first rollout: MOBILISE, then SuperRank, then Zennly, one after the other ----
import { advanceRollout, rolloutIds, DEFAULT_ROLLOUT } from './setup-pr-job.js';

function rollout(states, ids = [8874, 8871, 8872]) {
  const scheduled = [];
  const deps = {
    rolloutIds: () => ids,
    getState: async (id) => states[id] ?? null,
    schedule: async (id, at) => { scheduled.push([id, at]); states[id] = { ...(states[id] || {}), setup_pr_due_at: at }; },
  };
  return { deps, scheduled, states };
}
const fresh = () => ({ 8874: { setup_pr_due_at: null, setup_pr_done_at: null }, 8871: { setup_pr_due_at: null, setup_pr_done_at: null }, 8872: { setup_pr_due_at: null, setup_pr_done_at: null } });

test('the default order is MOBILISE, SuperRank, Zennly', () => {
  assert.deepEqual(DEFAULT_ROLLOUT, [8874, 8871, 8872]);
  assert.deepEqual(rolloutIds({}), [8874, 8871, 8872]);
});

test('the list can be overridden or switched off from the environment', () => {
  assert.deepEqual(rolloutIds({ SETUP_PR_ROLLOUT: '8871, 8872' }), [8871, 8872]);
  assert.deepEqual(rolloutIds({ SETUP_PR_ROLLOUT: 'off' }), []);
  assert.deepEqual(rolloutIds({ SETUP_PR_ROLLOUT: '' }), []);
  assert.deepEqual(rolloutIds({ SETUP_PR_ROLLOUT: 'x, 0, 12' }), [12]);
});

test('first pass schedules only MOBILISE, now; the others wait', async () => {
  const r = rollout(fresh());
  const out = await advanceRollout({ now: NOW, deps: r.deps, log: quiet });
  assert.deepEqual(out, { scheduled: 8874 });
  assert.deepEqual(r.scheduled, [[8874, NOW]]);
});

test('while MOBILISE is scheduled or running, nothing else is scheduled and it is not rescheduled', async () => {
  const r = rollout(fresh());
  await advanceRollout({ now: NOW, deps: r.deps, log: quiet });
  const again = await advanceRollout({ now: new Date(NOW.getTime() + 300000), deps: r.deps, log: quiet });
  assert.deepEqual(again, { waitingOn: 8874 });
  assert.equal(r.scheduled.length, 1);
});

test('once MOBILISE is done, SuperRank is scheduled; then Zennly; then the rollout is finished', async () => {
  const s = fresh(); const r = rollout(s);
  s[8874].setup_pr_done_at = NOW; s[8874].setup_pr_due_at = NOW;
  assert.deepEqual(await advanceRollout({ now: NOW, deps: r.deps, log: quiet }), { scheduled: 8871 });
  s[8871].setup_pr_done_at = NOW;
  assert.deepEqual(await advanceRollout({ now: NOW, deps: r.deps, log: quiet }), { scheduled: 8872 });
  s[8872].setup_pr_done_at = NOW;
  assert.deepEqual(await advanceRollout({ now: NOW, deps: r.deps, log: quiet }), { finished: true });
  assert.deepEqual(r.scheduled.map((x) => x[0]), [8871, 8872]);
});

test('a stuck project (retries used up, still not done) holds the queue: nothing after it starts', async () => {
  const s = fresh(); s[8874] = { setup_pr_due_at: NOW, setup_pr_done_at: null, setup_pr_attempts: 4 };
  const r = rollout(s);
  assert.deepEqual(await advanceRollout({ now: NOW, deps: r.deps, log: quiet }), { waitingOn: 8874 });
  assert.equal(r.scheduled.length, 0);
});

test('a project that does not exist is skipped, and an empty list does nothing', async () => {
  const s = fresh(); delete s[8874];
  const r = rollout(s);
  assert.deepEqual(await advanceRollout({ now: NOW, deps: r.deps, log: quiet }), { scheduled: 8871 });
  assert.deepEqual(await advanceRollout({ now: NOW, deps: rollout(fresh(), []).deps, log: quiet }), { finished: true });
});

test('the cron pass advances the rollout first, then runs what is due, and a rollout error never stops the pass', async () => {
  const h = harness({ rolloutIds: () => [8874], getState: async () => { throw new Error('db down'); } });
  const out = await runSetupPrsDue({ now: NOW, deps: h.deps, log: quiet });
  assert.equal(out.ran, 1);
});
