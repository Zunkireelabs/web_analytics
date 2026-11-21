import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyLiveDeployment, verifyStagedRepairs, openPlatformPromotion, verifyProductionReleases, runPlatformReleaseCycle,
  releaseAgentEnabled, LABEL, STAGING_WORKFLOW, PRODUCTION_WORKFLOW,
} from './platform-release.js';

const NOW = new Date('2026-11-21T12:00:00Z').getTime();
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const ENV = { ENABLE_PLATFORM_RELEASE_AGENT: 'true', PLATFORM_STAGING_URL: 'https://stage.example', PLATFORM_PRODUCTION_URL: 'https://prod.example' };
const REPAIR = (n, extra = {}) => ({ number: n, title: `repair ${n}`, url: `https://gh/pull/${n}`, headRef: `fix/self-repair-x-${n}`, base: 'stage', mergeSha: `sha${n}`, mergedAt: ago(30), labels: [], ...extra });
const RUN = (over = {}) => ({ id: 1, status: 'completed', conclusion: 'success', url: 'https://gh/run/1', createdAt: ago(20), ...over });

function res(status, body, contentType = 'application/json') {
  return { status, headers: { get: () => contentType }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
const GOOD_FETCH = async (url) => (String(url).endsWith('/api/health') ? res(200, { ok: true }) : res(200, '<!doctype html><title>x</title><div id="root"></div>', 'text/html; charset=utf-8'));
const fastLive = (fetchFn) => ({ fetchFn, attempts: 1, sleepFn: async () => {} });

function deps(over = {}) {
  const log = { labels: [], comments: [], opened: [], built: [] };
  return {
    log,
    d: {
      env: ENV, now: () => NOW,
      listMerged: async (_r, base) => (base === 'stage' ? [] : []),
      listOpen: async () => [],
      getRunsForSha: async () => [RUN()], getRunsForBranch: async () => [],
      addLabels: async (_r, n, labels) => { log.labels.push([n, ...labels]); },
      comment: async (_r, n, body) => { log.comments.push([n, body]); },
      verifyLive: async () => ({ ok: true, checks: [{ name: 'api-health', ok: true, detail: 'HTTP 200' }] }),
      buildBranch: async (_r, args) => { log.built.push(args); return { ok: true, noChange: false, branch: args.branchName, applied: args.prs.map((p) => ({ number: p.number, title: p.title, url: p.url })), skipped: [] }; },
      openPr: async (_r, args) => { log.opened.push(args); return { number: 700, url: 'https://gh/pull/700' }; },
      ...over,
    },
  };
}

// ============================ the live check ============================

test('live check: the app answers its health endpoint and serves the dashboard -> verified', async () => {
  const r = await verifyLiveDeployment({ url: 'https://x.example', ...fastLive(GOOD_FETCH) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map((c) => c.name), ['api-health', 'dashboard']);
});

test('live check: a 200 that is not { ok: true } is NOT healthy', async () => {
  const f = async (u) => (String(u).endsWith('/api/health') ? res(200, { ok: false }) : res(200, '<title>x</title>', 'text/html'));
  assert.equal((await verifyLiveDeployment({ url: 'https://x.example', ...fastLive(f) })).ok, false);
});

test('live check: an error page or a login redirect to the wrong thing is not "the dashboard"', async () => {
  const f = async (u) => (String(u).endsWith('/api/health') ? res(200, { ok: true }) : res(200, 'Bad Gateway', 'text/plain'));
  const r = await verifyLiveDeployment({ url: 'https://x.example', ...fastLive(f) });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === 'dashboard').ok, false);
});

test('live check: HTTP 5xx, unreachable and timed-out are all failures, never passes', async () => {
  for (const f of [async () => res(503, 'down', 'text/plain'), async () => { throw new Error('ECONNREFUSED'); }, async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; }]) {
    assert.equal((await verifyLiveDeployment({ url: 'https://x.example', ...fastLive(f) })).ok, false);
  }
});

test('live check: the MCP origin is checked when configured', async () => {
  const seen = [];
  const f = async (u) => { seen.push(String(u)); return GOOD_FETCH(u); };
  const r = await verifyLiveDeployment({ url: 'https://x.example', mcpUrl: 'https://mcp.example', ...fastLive(f) });
  assert.equal(r.ok, true);
  assert.ok(seen.includes('https://mcp.example/api/health'));
});

test('live check: a deploy that is still starting is retried, then passes', async () => {
  let calls = 0;
  const f = async (u) => { calls += 1; return calls <= 2 ? res(502, 'x', 'text/plain') : GOOD_FETCH(u); };
  const r = await verifyLiveDeployment({ url: 'https://x.example', fetchFn: f, attempts: 3, sleepFn: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2, 'the second attempt (calls 3 and 4) is the first to pass');
});

test('live check: no URL configured is a failure, not a pass', async () => {
  assert.equal((await verifyLiveDeployment({})).ok, false);
});

// ============================ staging verification ============================

test('OFF by default', async () => {
  assert.equal(releaseAgentEnabled({}), false);
  assert.deepEqual(await runPlatformReleaseCycle({ env: {} }), { ran: false, reason: 'disabled' });
});

test('STAGING: a merged self-repair whose deploy succeeded and whose live app passes is labelled verified, with the evidence', async () => {
  const x = deps({ listMerged: async () => [REPAIR(5)] });
  const r = await verifyStagedRepairs(x.d);
  assert.deepEqual(r.results.map((e) => e.state), ['verified']);
  assert.deepEqual(x.log.labels, [[5, LABEL.STAGING_VERIFIED]]);
  assert.match(x.log.comments[0][1], /Verified on staging/);
  assert.match(x.log.comments[0][1], /https:\/\/gh\/run\/1/);
  assert.match(x.log.comments[0][1], /PASS api-health/);
});

test('STAGING: only self-repair PRs, and only ones with no verdict yet', async () => {
  const x = deps({ listMerged: async () => [REPAIR(1), REPAIR(2, { labels: [LABEL.STAGING_VERIFIED] }), REPAIR(3, { labels: [LABEL.STAGING_FAILED] }), REPAIR(4, { headRef: 'feature/SRANK-9-x' })] });
  const r = await verifyStagedRepairs(x.d);
  assert.deepEqual(r.results.map((e) => e.prNumber), [1]);
});

test('STAGING FAIL CLOSED: no staging URL -> blocked, nothing is labelled verified', async () => {
  const x = deps({ env: { ...ENV, PLATFORM_STAGING_URL: '' }, listMerged: async () => [REPAIR(5)] });
  const r = await verifyStagedRepairs(x.d);
  assert.equal(r.results[0].state, 'blocked');
  assert.equal(r.results[0].reason, 'staging-url-not-configured');
  assert.deepEqual(x.log.labels, []);
});

test('STAGING: the deploy has not started or is still running -> wait, label nothing', async () => {
  for (const runs of [[], [RUN({ status: 'in_progress', conclusion: null })], [RUN({ status: 'queued', conclusion: null })]]) {
    const x = deps({ listMerged: async () => [REPAIR(5)], getRunsForSha: async () => runs });
    assert.equal((await verifyStagedRepairs(x.d)).results[0].state, 'waiting');
    assert.deepEqual(x.log.labels, []);
  }
});

test('STAGING: no deploy run an hour after the merge is a failure, not an eternal wait', async () => {
  const x = deps({ listMerged: async () => [REPAIR(5, { mergedAt: ago(90) })], getRunsForSha: async () => [] });
  const r = await verifyStagedRepairs(x.d);
  assert.equal(r.results[0].state, 'failed');
  assert.deepEqual(x.log.labels, [[5, LABEL.STAGING_FAILED]]);
});

test('STAGING: a failed deploy run marks it failed and says it will not be promoted', async () => {
  const x = deps({ listMerged: async () => [REPAIR(5)], getRunsForSha: async () => [RUN({ conclusion: 'failure' })] });
  const r = await verifyStagedRepairs(x.d);
  assert.equal(r.results[0].state, 'failed');
  assert.deepEqual(x.log.labels, [[5, LABEL.STAGING_FAILED]]);
  assert.match(x.log.comments[0][1], /will not be promoted/);
});

test('STAGING: a run GitHub cancelled in favour of a newer push counts ONLY if a later run on stage succeeded', async () => {
  const cancelled = RUN({ conclusion: 'cancelled' });
  const ok = deps({ listMerged: async () => [REPAIR(5)], getRunsForSha: async () => [cancelled], getRunsForBranch: async () => [RUN({ id: 2, createdAt: ago(5) })] });
  assert.equal((await verifyStagedRepairs(ok.d)).results[0].state, 'verified');
  const no = deps({ listMerged: async () => [REPAIR(5)], getRunsForSha: async () => [cancelled], getRunsForBranch: async () => [RUN({ id: 2, createdAt: ago(100) })] });
  assert.equal((await verifyStagedRepairs(no.d)).results[0].state, 'failed');
  const none = deps({ listMerged: async () => [REPAIR(5)], getRunsForSha: async () => [cancelled], getRunsForBranch: async () => [] });
  assert.equal((await verifyStagedRepairs(none.d)).results[0].state, 'failed');
});

test('STAGING: the deploy passed but the live app does not answer — wait during the grace period, then fail; NEVER verified', async () => {
  const dead = { ok: false, checks: [{ name: 'api-health', ok: false, detail: 'HTTP 502' }] };
  const fresh = deps({ listMerged: async () => [REPAIR(5)], getRunsForSha: async () => [RUN({ createdAt: ago(3) })], verifyLive: async () => dead });
  assert.equal((await verifyStagedRepairs(fresh.d)).results[0].state, 'waiting');
  assert.deepEqual(fresh.log.labels, []);
  const old = deps({ listMerged: async () => [REPAIR(5)], getRunsForSha: async () => [RUN({ createdAt: ago(60) })], verifyLive: async () => dead });
  const r = await verifyStagedRepairs(old.d);
  assert.equal(r.results[0].state, 'failed');
  assert.deepEqual(old.log.labels, [[5, LABEL.STAGING_FAILED]]);
  assert.match(old.log.comments[0][1], /FAIL api-health: HTTP 502/);
});

test('STAGING: a GitHub or network error leaves the PR unverified and retried — never failed, never verified', async () => {
  const x = deps({ listMerged: async () => [REPAIR(5)], getRunsForSha: async () => { throw new Error('boom'); } });
  const r = await verifyStagedRepairs(x.d);
  assert.equal(r.results[0].state, 'waiting');
  assert.deepEqual(x.log.labels, []);
  assert.equal((await verifyStagedRepairs(deps({ listMerged: async () => { throw new Error('x'); } }).d)).ran, false);
});

test('STAGING: uses the repo\'s own deploy workflow for the merge commit', async () => {
  const asked = [];
  const x = deps({ listMerged: async () => [REPAIR(5)], getRunsForSha: async (_r, wf, sha) => { asked.push([wf, sha]); return [RUN()]; } });
  await verifyStagedRepairs(x.d);
  assert.deepEqual(asked, [[STAGING_WORKFLOW, 'sha5']]);
  assert.equal(STAGING_WORKFLOW, 'deploy-staging.yml');
});

test('STAGING: an unsafe stage branch (production) verifies nothing', async () => {
  const x = deps({ env: { ...ENV, PLATFORM_REPO_BASE_BRANCH: 'main' }, listMerged: async () => [REPAIR(5)] });
  const r = await verifyStagedRepairs(x.d);
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'unsafe-base-branch');
});

// ============================ promotion ============================

const VERIFIED = (n, extra = {}) => REPAIR(n, { labels: [LABEL.STAGING_VERIFIED], ...extra });

test('PROMOTE: a fresh branch from main with ONLY the verified, unpromoted self-repairs; a PR into main; nothing merged', async () => {
  const x = deps({ listMerged: async () => [VERIFIED(1), VERIFIED(2, { labels: [LABEL.STAGING_VERIFIED, LABEL.PROMOTED] }), REPAIR(3), REPAIR(4, { labels: [LABEL.STAGING_FAILED] }), VERIFIED(5, { headRef: 'feature/x' })] });
  const r = await openPlatformPromotion(x.d);
  assert.deepEqual(x.log.built[0].prs.map((p) => p.number), [1], 'unverified, failed, already-promoted and non-repair PRs are never included');
  assert.equal(x.log.built[0].main, 'main', 'cut from the production branch');
  assert.match(x.log.built[0].branchName, /^promote\/stage-20261121-1$/);
  assert.equal(x.log.opened[0].base, 'main');
  assert.equal(x.log.opened[0].branch, 'promote/stage-20261121-1');
  assert.deepEqual(r.opened, { number: 700, url: 'https://gh/pull/700' });
  assert.match(x.log.opened[0].body, /This needs a person/);
  assert.match(x.log.opened[0].body, /never merges into `main`/);
  assert.deepEqual(x.log.labels, [[1, LABEL.PROMOTED]]);
});

test('PROMOTE: the agent has no way to merge — no merge function is in its reach', async () => {
  const x = deps({ listMerged: async () => [VERIFIED(1)] });
  await openPlatformPromotion(x.d);
  assert.deepEqual(Object.keys(x.d).filter((k) => /merge/i.test(k) && k !== 'listMerged'), []);
});

test('PROMOTE: nothing verified means nothing is built or opened', async () => {
  const x = deps({ listMerged: async () => [REPAIR(1), REPAIR(2)] });
  const r = await openPlatformPromotion(x.d);
  assert.equal(r.reason, 'nothing-verified-to-promote');
  assert.equal(x.log.built.length, 0);
  assert.equal(x.log.opened.length, 0);
});

test('PROMOTE: one promotion at a time — while a person has one open, no second is made', async () => {
  const x = deps({ listMerged: async () => [VERIFIED(1)], listOpen: async () => [{ number: 9, headRef: 'promote/stage-20261120-4', base: 'main' }] });
  const r = await openPlatformPromotion(x.d);
  assert.equal(r.reason, 'promotion-already-open');
  assert.equal(x.log.built.length, 0);
});

test('PROMOTE: what main has moved past is held back, named once, and never forced', async () => {
  const x = deps({
    listMerged: async () => [VERIFIED(1), VERIFIED(2)],
    buildBranch: async (_r, args) => ({ ok: true, noChange: false, branch: args.branchName, applied: [{ number: 1, title: 't', url: 'u' }], skipped: [{ number: 2, reason: 'main-changed', detail: 'server/a.js' }] }),
  });
  await openPlatformPromotion(x.d);
  assert.ok(x.log.labels.some((l) => l[0] === 2 && l[1] === LABEL.HELD_BACK));
  assert.ok(x.log.labels.some((l) => l[0] === 1 && l[1] === LABEL.PROMOTED));
  assert.match(x.log.opened[0].body, /Held back/);
  const again = deps({
    listMerged: async () => [VERIFIED(2, { labels: [LABEL.STAGING_VERIFIED, LABEL.HELD_BACK] })],
    buildBranch: async () => ({ ok: true, noChange: true, branch: null, applied: [], skipped: [{ number: 2, reason: 'main-changed', detail: 'server/a.js' }] }),
  });
  const r = await openPlatformPromotion(again.d);
  assert.equal(r.reason, 'promotion-held-back');
  assert.equal(again.log.labels.length, 0, 'already marked: no repeated comment');
  assert.equal(again.log.opened.length, 0);
});

test('PROMOTE: a failed branch build opens nothing', async () => {
  const x = deps({ listMerged: async () => [VERIFIED(1)], buildBranch: async () => ({ ok: false, reason: 'bad-input' }) });
  const r = await openPlatformPromotion(x.d);
  assert.equal(r.opened, null);
  assert.equal(x.log.opened.length, 0);
});

test('PROMOTE: an unsafe stage/production configuration promotes nothing', async () => {
  const x = deps({ env: { ...ENV, PLATFORM_REPO_BASE_BRANCH: 'main' }, listMerged: async () => [VERIFIED(1)] });
  assert.equal((await openPlatformPromotion(x.d)).ran, false);
});

// ============================ production verification ============================

const PROMO = (n, extra = {}) => ({ number: n, title: 'promote', url: `https://gh/pull/${n}`, headRef: 'promote/stage-20261121-1', base: 'main', mergeSha: `msha${n}`, mergedAt: ago(30), labels: [], ...extra });

test('PRODUCTION: after a person merges the promotion, the production deploy and live app are verified and the PR is labelled', async () => {
  const asked = [];
  const x = deps({ listMerged: async (_r, base) => (base === 'main' ? [PROMO(700)] : []), getRunsForSha: async (_r, wf, sha) => { asked.push([wf, sha]); return [RUN()]; } });
  const r = await verifyProductionReleases(x.d);
  assert.equal(r.results[0].state, 'verified');
  assert.deepEqual(asked, [[PRODUCTION_WORKFLOW, 'msha700']]);
  assert.equal(PRODUCTION_WORKFLOW, 'deploy.yml');
  assert.deepEqual(x.log.labels, [[700, LABEL.PRODUCTION_VERIFIED]]);
  assert.match(x.log.comments[0][1], /Verified in production/);
});

test('PRODUCTION: only promotion PRs, and only those without a verdict', async () => {
  const x = deps({ listMerged: async (_r, base) => (base === 'main' ? [PROMO(1), PROMO(2, { labels: [LABEL.PRODUCTION_VERIFIED] }), PROMO(3, { headRef: 'feature/SRANK-1' }), PROMO(4, { labels: [LABEL.PRODUCTION_FAILED] })] : []) });
  assert.deepEqual((await verifyProductionReleases(x.d)).results.map((e) => e.prNumber), [1]);
});

test('PRODUCTION: a failed deploy or a dead app is reported with the rollback to use — and the agent does NOT roll back by itself', async () => {
  const failed = deps({ listMerged: async (_r, b) => (b === 'main' ? [PROMO(700)] : []), getRunsForSha: async () => [RUN({ conclusion: 'failure' })] });
  const a = await verifyProductionReleases(failed.d);
  assert.equal(a.results[0].state, 'failed');
  assert.deepEqual(failed.log.labels, [[700, LABEL.PRODUCTION_FAILED]]);
  assert.match(failed.log.comments[0][1], /Rollback/);
  assert.match(failed.log.comments[0][1], /The agent does not trigger it/);

  const dead = deps({ listMerged: async (_r, b) => (b === 'main' ? [PROMO(700)] : []), getRunsForSha: async () => [RUN({ createdAt: ago(60) })], verifyLive: async () => ({ ok: false, checks: [{ name: 'api-health', ok: false, detail: 'HTTP 500' }] }) });
  assert.equal((await verifyProductionReleases(dead.d)).results[0].state, 'failed');
  assert.equal(Object.keys(dead.d).filter((k) => /rollback|dispatch|trigger/i.test(k)).length, 0);
});

test('PRODUCTION FAIL CLOSED: no production URL, a running deploy, or an unreadable run is never "verified"', async () => {
  const noUrl = deps({ env: { ...ENV, PLATFORM_PRODUCTION_URL: '' }, listMerged: async (_r, b) => (b === 'main' ? [PROMO(1)] : []) });
  assert.equal((await verifyProductionReleases(noUrl.d)).results[0].reason, 'production-url-not-configured');
  const running = deps({ listMerged: async (_r, b) => (b === 'main' ? [PROMO(1)] : []), getRunsForSha: async () => [RUN({ status: 'in_progress', conclusion: null })] });
  assert.equal((await verifyProductionReleases(running.d)).results[0].state, 'waiting');
  const broken = deps({ listMerged: async (_r, b) => (b === 'main' ? [PROMO(1)] : []), getRunsForSha: async () => { throw new Error('x'); } });
  assert.equal((await verifyProductionReleases(broken.d)).results[0].state, 'waiting');
  for (const t of [noUrl, running, broken]) assert.deepEqual(t.log.labels, []);
});

// ============================ the cycle ============================

test('CYCLE: runs staging verification, promotion and production verification in order', async () => {
  const x = deps({ listMerged: async (_r, base) => (base === 'stage' ? [REPAIR(5)] : [PROMO(700)]) });
  const r = await runPlatformReleaseCycle(x.d);
  assert.equal(r.ran, true);
  assert.equal(r.staging.results[0].state, 'verified');
  assert.equal(r.production.results[0].state, 'verified');
  assert.ok(r.promotion);
});

test('CYCLE: a step that throws never stops the others and never throws into the scheduler', async () => {
  const x = deps({ listMerged: async () => { throw new Error('GitHub down'); } });
  const r = await runPlatformReleaseCycle(x.d);
  assert.equal(r.ran, true);
  assert.equal(r.staging.ran, false);
  assert.equal(r.promotion.ran, false);
  assert.equal(r.production.ran, false);
});
