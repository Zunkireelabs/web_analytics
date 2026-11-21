// THE PLATFORM RELEASE AGENT — the part of the approved workflow after a self-repair PR is merged into stage:
//
//   merged into stage  ->  the repo's OWN deploy-staging.yml deploys it (it triggers on every push to stage)
//   VERIFY STAGING     ->  that deploy run succeeded for this merge, AND the live staging app answers a real health and
//                          application check made by this agent, independently of the workflow's own step
//   PROMOTE            ->  a fresh branch cut from the LATEST main containing ONLY the PRs that passed staging verification
//                          (lib/promotion-branch.js), and a PR into main. NEVER merged by an agent.
//   (a person reviews and merges the promotion PR; deploy.yml then deploys production)
//   VERIFY PRODUCTION  ->  the production deploy run succeeded for the merge, and live production passes the same checks;
//                          if it does not, the PR is marked and a person is told, with the rollback workflow to use.
//
// STATE is carried by labels on the pull requests themselves (staging-verified, promoted, production-verified, ...): visible to
// anyone looking at GitHub, auditable, and needing no database. Every step is idempotent, so the scheduler can repeat it.
//
// FAIL CLOSED: a deploy that is still running, a missing URL, an unreadable run, an unreachable app — each leaves the PR
// UNVERIFIED, and an unverified PR is never promoted. The agent never merges into main and never triggers a deploy or a
// rollback itself: the deploys are the repo's own workflows, run by GitHub, on the merges a person approved.
//
// Off unless ENABLE_PLATFORM_RELEASE_AGENT=true. Configuration it needs (nothing is guessed):
//   PLATFORM_STAGING_URL      https://<the STAGING_DOMAIN repo variable>
//   PLATFORM_PRODUCTION_URL   https://<the PROD_DOMAIN repo variable>
//   (optional) PLATFORM_STAGING_MCP_URL / PLATFORM_PRODUCTION_MCP_URL   the MCP domains, also checked when set
import {
  listMergedPullRequestsForBase, listOpenPullRequestsForBase, getWorkflowRunsForSha, getWorkflowRunsForBranch, addPullRequestLabels,
  commentOnPullRequest, openPullRequest, getBranchSha,
} from '../../github/client.js';
import { buildPromotionBranch } from '../../lib/promotion-branch.js';
import { PLATFORM_REPO } from './code-self-repair.js';
import { checkRepairBase, platformBranches, SELF_REPAIR_BRANCH_PREFIX } from './platform-branch-policy.js';

export const STAGING_WORKFLOW = 'deploy-staging.yml';
export const PRODUCTION_WORKFLOW = 'deploy.yml';
export const PROMOTION_BRANCH_PREFIX = 'promote/stage-';
export const LABEL = Object.freeze({
  STAGING_VERIFIED: 'staging-verified', STAGING_FAILED: 'staging-failed', PROMOTED: 'promoted', HELD_BACK: 'promotion-held-back',
  PRODUCTION_VERIFIED: 'production-verified', PRODUCTION_FAILED: 'production-failed',
});

// How long to wait for things GitHub should do on its own before calling it a failure.
const NO_DEPLOY_RUN_AFTER_MS = 60 * 60 * 1000;   // a merge into stage/main with no deploy run an hour later
const HEALTH_GRACE_MS = 15 * 60 * 1000;          // a just-finished deploy may need a few minutes before it answers
const minutes = (ms) => Math.round(ms / 60000);

export function releaseAgentEnabled(env = process.env) {
  return env.ENABLE_PLATFORM_RELEASE_AGENT === 'true';
}

// ---- the real check: is the live app up and is it the dashboard? ---------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(fetchFn, url, { timeoutMs = 10000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'platform-release-agent' } });
    return { status: res.status, contentType: res.headers?.get?.('content-type') || '', text: await res.text().catch(() => '') };
  } catch (err) {
    return { status: 0, error: err.name === 'AbortError' ? 'timed out' : 'unreachable' };
  } finally { clearTimeout(timer); }
}

/**
 * Health and application verification of a live deployment, from outside, the way a user reaches it.
 *   - GET /api/health answers 200 with { ok: true }        (the app's own health endpoint)
 *   - GET /          answers 200 with the dashboard page    (the built front end is being served, not an error page)
 *   - the MCP origin's /api/health, when configured
 * Retried a few times: a deploy that just finished can take a moment to start answering.
 */
export async function verifyLiveDeployment({ url, mcpUrl = null, fetchFn = fetch, attempts = 3, delayMs = 5000, sleepFn = sleep } = {}) {
  if (!url) return { ok: false, checks: [{ name: 'configuration', ok: false, detail: 'no URL configured' }] };
  const base = String(url).replace(/\/+$/, '');
  const one = async () => {
    const checks = [];
    const health = await http(fetchFn, `${base}/api/health`);
    let healthOk = false;
    if (health.status === 200) { try { healthOk = JSON.parse(health.text)?.ok === true; } catch { healthOk = false; } }
    checks.push({ name: 'api-health', ok: healthOk, detail: health.error || `HTTP ${health.status}${healthOk ? '' : ' without { ok: true }'}` });
    const home = await http(fetchFn, `${base}/`);
    const isApp = home.status === 200 && /text\/html/i.test(home.contentType) && /id=["']root["']|<title/i.test(home.text);
    checks.push({ name: 'dashboard', ok: isApp, detail: home.error || `HTTP ${home.status}${isApp ? '' : ' and not the dashboard page'}` });
    if (mcpUrl) {
      const mcp = await http(fetchFn, `${String(mcpUrl).replace(/\/+$/, '')}/api/health`);
      checks.push({ name: 'mcp-health', ok: mcp.status === 200, detail: mcp.error || `HTTP ${mcp.status}` });
    }
    return checks;
  };
  let checks = [];
  for (let i = 1; i <= attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    checks = await one();
    if (checks.every((c) => c.ok)) return { ok: true, checks, attempts: i };
    // eslint-disable-next-line no-await-in-loop
    if (i < attempts) await sleepFn(delayMs);
  }
  return { ok: false, checks, attempts };
}

const describeChecks = (checks) => checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`).join('\n');

// ---- reading the deploy that GitHub ran ----------------------------------------------------------------------------------
// -> { state: 'success'|'running'|'missing'|'failed', run, note }
async function deployOutcome({ repo, workflow, sha, branch, mergedAt, now, getRunsForSha, getRunsForBranch }) {
  const runs = await getRunsForSha(repo, workflow, sha);
  const latest = [...runs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!latest) {
    const age = now - new Date(mergedAt).getTime();
    return age > NO_DEPLOY_RUN_AFTER_MS ? { state: 'failed', note: `no ${workflow} run appeared ${minutes(age)} minutes after the merge` } : { state: 'missing', note: 'the deploy has not started yet' };
  }
  if (latest.status !== 'completed') return { state: 'running', run: latest, note: 'the deploy is still running' };
  if (latest.conclusion === 'success') return { state: 'success', run: latest };
  if (latest.conclusion === 'cancelled') {
    // GitHub replaces an older PENDING run when a newer push arrives. The newer run deploys the branch head, which includes
    // this merge — so a later SUCCESSFUL run on the branch counts, and only that.
    const later = (await getRunsForBranch(repo, workflow, branch)).find((r) => r.status === 'completed' && r.conclusion === 'success' && new Date(r.createdAt) > new Date(mergedAt));
    return later ? { state: 'success', run: later, note: 'deployed by a later run that includes this merge' } : { state: 'failed', run: latest, note: 'its deploy run was cancelled and no later run succeeded' };
  }
  return { state: 'failed', run: latest, note: `the deploy run ended "${latest.conclusion}"` };
}

async function mark(repo, prNumber, label, comment, deps) {
  await deps.addLabels(repo, prNumber, [label]);
  if (comment) await deps.comment(repo, prNumber, comment).catch(() => {});
}

function envDeps(deps) {
  const env = deps.env || process.env;
  return {
    env, repo: deps.repo || PLATFORM_REPO, now: (deps.now || (() => Date.now()))(),
    listMerged: deps.listMerged || listMergedPullRequestsForBase, listOpen: deps.listOpen || listOpenPullRequestsForBase,
    getRunsForSha: deps.getRunsForSha || getWorkflowRunsForSha, getRunsForBranch: deps.getRunsForBranch || getWorkflowRunsForBranch,
    addLabels: deps.addLabels || addPullRequestLabels, comment: deps.comment || commentOnPullRequest,
    verifyLive: deps.verifyLive || verifyLiveDeployment, buildBranch: deps.buildBranch || buildPromotionBranch,
    openPr: deps.openPr || openPullRequest, readSha: deps.readSha || getBranchSha, fetchFn: deps.fetchFn || fetch,
  };
}

// ---- 1. VERIFY STAGING ---------------------------------------------------------------------------------------------------
export async function verifyStagedRepairs(inDeps = {}) {
  const d = envDeps(inDeps);
  const target = checkRepairBase(d.env);
  if (!target.ok) return { ran: false, reason: target.reason, results: [] };
  const url = d.env.PLATFORM_STAGING_URL;
  const results = [];
  let merged;
  try { merged = await d.listMerged(d.repo, target.stage); } catch { return { ran: false, reason: 'github-error', results }; }
  const pending = merged.filter((pr) => String(pr.headRef || '').startsWith(SELF_REPAIR_BRANCH_PREFIX)
    && !pr.labels.includes(LABEL.STAGING_VERIFIED) && !pr.labels.includes(LABEL.STAGING_FAILED));
  for (const pr of pending) {
    // Without a URL nothing can be verified, and an unverified PR is never promoted. Said plainly, once per sweep.
    if (!url) { results.push({ prNumber: pr.number, state: 'blocked', reason: 'staging-url-not-configured' }); continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await deployOutcome({ repo: d.repo, workflow: STAGING_WORKFLOW, sha: pr.mergeSha, branch: target.stage, mergedAt: pr.mergedAt, now: d.now, getRunsForSha: d.getRunsForSha, getRunsForBranch: d.getRunsForBranch });
      if (out.state === 'missing' || out.state === 'running') { results.push({ prNumber: pr.number, state: 'waiting', reason: out.note }); continue; }
      if (out.state === 'failed') {
        // eslint-disable-next-line no-await-in-loop
        await mark(d.repo, pr.number, LABEL.STAGING_FAILED, `**Staging verification failed:** ${out.note}.${out.run ? ` Deploy run: ${out.run.url}` : ''}\n\nThis change will not be promoted to \`${platformBranches(d.env).production}\`.`, d);
        results.push({ prNumber: pr.number, state: 'failed', reason: out.note });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const live = await d.verifyLive({ url, mcpUrl: d.env.PLATFORM_STAGING_MCP_URL || null, fetchFn: d.fetchFn });
      if (live.ok) {
        // eslint-disable-next-line no-await-in-loop
        await mark(d.repo, pr.number, LABEL.STAGING_VERIFIED, `**Verified on staging.** Deploy run: ${out.run.url}\n\n${describeChecks(live.checks)}\n\nEligible for promotion to \`${platformBranches(d.env).production}\`, which a person reviews and merges.`, d);
        results.push({ prNumber: pr.number, state: 'verified' });
      } else if (d.now - new Date(out.run.createdAt).getTime() < HEALTH_GRACE_MS) {
        results.push({ prNumber: pr.number, state: 'waiting', reason: 'the app is not answering yet; allowing time after the deploy' });
      } else {
        // eslint-disable-next-line no-await-in-loop
        await mark(d.repo, pr.number, LABEL.STAGING_FAILED, `**Staging verification failed.** The deploy succeeded but the live app did not pass its checks:\n\n${describeChecks(live.checks)}\n\nThis change will not be promoted.`, d);
        results.push({ prNumber: pr.number, state: 'failed', reason: 'live checks failed' });
      }
    } catch {
      results.push({ prNumber: pr.number, state: 'waiting', reason: 'could not read GitHub; will retry' });
    }
  }
  return { ran: true, results };
}

// ---- 2. PROMOTE ------------------------------------------------------------------------------------------------------------
export async function openPlatformPromotion(inDeps = {}) {
  const d = envDeps(inDeps);
  const target = checkRepairBase(d.env);
  if (!target.ok) return { ran: false, reason: target.reason };
  const { stage, production } = target;
  let merged; let open;
  try {
    merged = await d.listMerged(d.repo, stage);
    open = await d.listOpen(d.repo, production);
  } catch { return { ran: false, reason: 'github-error' }; }

  // One promotion at a time: while a person has one open for review, a second would only overlap it.
  if (open.some((pr) => String(pr.headRef || '').startsWith(PROMOTION_BRANCH_PREFIX))) return { ran: true, opened: null, reason: 'promotion-already-open' };

  const ready = merged.filter((pr) => String(pr.headRef || '').startsWith(SELF_REPAIR_BRANCH_PREFIX)
    && pr.labels.includes(LABEL.STAGING_VERIFIED) && !pr.labels.includes(LABEL.PROMOTED) && !pr.labels.includes(LABEL.STAGING_FAILED));
  if (!ready.length) return { ran: true, opened: null, reason: 'nothing-verified-to-promote' };

  const stamp = new Date(d.now).toISOString().slice(0, 10).replace(/-/g, '');
  const branchName = `${PROMOTION_BRANCH_PREFIX}${stamp}-${Math.min(...ready.map((p) => p.number))}`;
  const built = await d.buildBranch(d.repo, { main: production, prs: ready, branchName, message: `Promote ${ready.length} verified self-repair${ready.length === 1 ? '' : 's'} from ${stage}` });
  if (!built.ok) return { ran: true, opened: null, reason: built.reason || 'promotion-failed' };

  // Whatever main has moved past is held back and named, once — never forced, never silently dropped.
  for (const s of built.skipped || []) {
    const pr = ready.find((p) => p.number === s.number);
    if (pr && !pr.labels.includes(LABEL.HELD_BACK)) {
      // eslint-disable-next-line no-await-in-loop
      await mark(d.repo, s.number, LABEL.HELD_BACK, `Not promoted: \`${production}\` has changed since this was merged (${s.reason}: \`${s.detail}\`). A person needs to look at it.`, d).catch(() => {});
    }
  }
  if (built.noChange) return { ran: true, opened: null, reason: (built.skipped || []).length ? 'promotion-held-back' : 'already-on-main', skipped: built.skipped || [] };

  const lines = built.applied.map((a) => `- #${a.number} ${a.title || ''} ${a.url || ''}`.trim()).join('\n');
  const held = (built.skipped || []).map((s) => `- #${s.number} (${s.reason}: \`${s.detail}\`)`).join('\n');
  const { number, url } = await d.openPr(d.repo, {
    branch: built.branch, base: production,
    title: `Promote ${built.applied.length} verified platform self-repair${built.applied.length === 1 ? '' : 's'} to ${production}`,
    body: `A fresh branch cut from the latest \`${production}\`. It contains only the self-repairs that were merged into \`${stage}\`, deployed there, and passed staging verification:\n${lines}\n\n`
      + (held ? `Held back, because \`${production}\` has changed those files since:\n${held}\n\n` : '')
      + `Each was deployed to staging by \`${STAGING_WORKFLOW}\` and checked against the live staging app (see the comment on each PR).\n\n`
      + `**This needs a person.** Review the diff and merge it to release; the agent never merges into \`${production}\`. Production deployment is then run by \`${PRODUCTION_WORKFLOW}\` and verified by the agent.`,
  });
  for (const a of built.applied) {
    // eslint-disable-next-line no-await-in-loop
    await mark(d.repo, a.number, LABEL.PROMOTED, `Included in promotion PR #${number}: ${url}`, d).catch(() => {});
  }
  return { ran: true, opened: { number, url }, applied: built.applied.map((a) => a.number), skipped: built.skipped || [] };
}

// ---- 3. VERIFY PRODUCTION --------------------------------------------------------------------------------------------------
export async function verifyProductionReleases(inDeps = {}) {
  const d = envDeps(inDeps);
  const target = checkRepairBase(d.env);
  if (!target.ok) return { ran: false, reason: target.reason, results: [] };
  const { production } = target;
  const url = d.env.PLATFORM_PRODUCTION_URL;
  const results = [];
  let merged;
  try { merged = await d.listMerged(d.repo, production); } catch { return { ran: false, reason: 'github-error', results }; }
  const pending = merged.filter((pr) => String(pr.headRef || '').startsWith(PROMOTION_BRANCH_PREFIX)
    && !pr.labels.includes(LABEL.PRODUCTION_VERIFIED) && !pr.labels.includes(LABEL.PRODUCTION_FAILED));
  for (const pr of pending) {
    if (!url) { results.push({ prNumber: pr.number, state: 'blocked', reason: 'production-url-not-configured' }); continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await deployOutcome({ repo: d.repo, workflow: PRODUCTION_WORKFLOW, sha: pr.mergeSha, branch: production, mergedAt: pr.mergedAt, now: d.now, getRunsForSha: d.getRunsForSha, getRunsForBranch: d.getRunsForBranch });
      if (out.state === 'missing' || out.state === 'running') { results.push({ prNumber: pr.number, state: 'waiting', reason: out.note }); continue; }
      const rollback = `To roll back, run the "Rollback" workflow (environment: production) with the commit before ${String(pr.mergeSha).slice(0, 7)}. The agent does not trigger it.`;
      if (out.state === 'failed') {
        // eslint-disable-next-line no-await-in-loop
        await mark(d.repo, pr.number, LABEL.PRODUCTION_FAILED, `**Production deployment failed:** ${out.note}.${out.run ? ` Run: ${out.run.url}` : ''}\n\n${rollback}`, d);
        results.push({ prNumber: pr.number, state: 'failed', reason: out.note });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const live = await d.verifyLive({ url, mcpUrl: d.env.PLATFORM_PRODUCTION_MCP_URL || null, fetchFn: d.fetchFn });
      if (live.ok) {
        // eslint-disable-next-line no-await-in-loop
        await mark(d.repo, pr.number, LABEL.PRODUCTION_VERIFIED, `**Verified in production.** Deploy run: ${out.run.url}\n\n${describeChecks(live.checks)}`, d);
        results.push({ prNumber: pr.number, state: 'verified' });
      } else if (d.now - new Date(out.run.createdAt).getTime() < HEALTH_GRACE_MS) {
        results.push({ prNumber: pr.number, state: 'waiting', reason: 'the app is not answering yet; allowing time after the deploy' });
      } else {
        // eslint-disable-next-line no-await-in-loop
        await mark(d.repo, pr.number, LABEL.PRODUCTION_FAILED, `**Production verification failed.** The deploy succeeded but the live app did not pass its checks:\n\n${describeChecks(live.checks)}\n\n${rollback}`, d);
        results.push({ prNumber: pr.number, state: 'failed', reason: 'live checks failed' });
      }
    } catch {
      results.push({ prNumber: pr.number, state: 'waiting', reason: 'could not read GitHub; will retry' });
    }
  }
  return { ran: true, results };
}

// ---- the cycle ------------------------------------------------------------------------------------------------------------
// One pass: verify what reached staging, open the promotion for what passed, verify what a person released to production.
// Each step is independent and never throws into the scheduler.
export async function runPlatformReleaseCycle(deps = {}) {
  const env = deps.env || process.env;
  if (!releaseAgentEnabled(env)) return { ran: false, reason: 'disabled' };
  const safe = async (fn) => { try { return await fn(deps); } catch { return { ran: false, reason: 'error' }; } };
  return {
    ran: true,
    staging: await safe(verifyStagedRepairs),
    promotion: await safe(openPlatformPromotion),
    production: await safe(verifyProductionReleases),
  };
}
