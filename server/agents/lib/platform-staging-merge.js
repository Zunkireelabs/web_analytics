// THE AUTHORISED STAGING AGENT for platform self-repair PRs.
//
// A validated repair is merged into STAGE without a person; nothing here can reach main. Every guard must pass or
// nothing is merged, and the reason is returned (never thrown, never silent). Fail closed throughout: "could not tell"
// is never "fine".
//
//   policy         stage must be a real, non-production branch (platform-branch-policy.js)
//   not-stage      the PR must target stage — a PR into main is never merged here
//   not-a-repair   only fix/self-repair-* branches
//   not-open       closed or already merged
//   conflicts      GitHub says it cannot merge cleanly
//   no-checks      NO checks visible at all: unknown is not green
//   checks-pending / checks-failed
//
// Off unless ENABLE_PLATFORM_STAGING_AUTOMERGE=true. Enable it only where a stage environment exists and is the thing
// that gets verified; production configuration is left unchanged.
import { getPullRequest, getCheckRunsForRef, mergePullRequest, listOpenPullRequestsForBase } from '../../github/client.js';
import { checkAutoMergeTarget, checkRepairBase } from './platform-branch-policy.js';
import { PLATFORM_REPO } from './code-self-repair.js';

const GOOD = new Set(['success', 'neutral', 'skipped']);
const refuse = (reason, error) => ({ ok: false, merged: false, reason, error });

export function stagingAutomergeEnabled(env = process.env) {
  return env.ENABLE_PLATFORM_STAGING_AUTOMERGE === 'true';
}

export async function mergePlatformRepairToStage(prNumber, deps = {}) {
  const {
    env = process.env, repo = PLATFORM_REPO,
    getPr = getPullRequest, getChecks = getCheckRunsForRef, merge = mergePullRequest,
  } = deps;
  if (!stagingAutomergeEnabled(env)) return refuse('disabled', 'Automatic staging merges are switched off.');
  const target = checkRepairBase(env);
  if (!target.ok) return refuse(target.reason, target.error);

  let pr;
  try { pr = await getPr(repo, prNumber); } catch { return refuse('github-error', 'GitHub could not be reached, so nothing was merged.'); }
  if (!pr || pr.state !== 'open' || pr.merged) return refuse('not-open', 'That pull request is not open.');
  const allowed = checkAutoMergeTarget({ base: pr.base, headRef: pr.headRef }, env);
  if (!allowed.ok) return refuse(allowed.reason, allowed.error);
  if (pr.mergeable === false) return refuse('conflicts', 'GitHub says this cannot be merged cleanly yet.');

  let checks;
  try { checks = await getChecks(repo, pr.headSha); } catch { return refuse('checks-pending', 'The checks could not be read, so nothing was merged.'); }
  if (!Array.isArray(checks) || checks.length === 0) return refuse('no-checks', 'No checks are visible on this pull request. Unknown is not green, so it was not merged.');
  if (checks.some((c) => c.status !== 'completed')) return refuse('checks-pending', 'The checks are still running.');
  if (checks.some((c) => !GOOD.has(c.conclusion))) return refuse('checks-failed', 'A check failed, so it was not merged.');

  let out;
  try { out = await merge(repo, prNumber, { sha: pr.headSha }); } catch { return refuse('github-error', 'GitHub did not complete the merge.'); }
  if (!out?.merged) return refuse('not-merged', 'GitHub did not merge it.');
  return { ok: true, merged: true, sha: out.sha, base: target.stage };
}

// One pass over every open self-repair PR waiting on stage. Idempotent: a PR that is not ready is simply retried on the
// next pass, and nothing here ever throws into the scheduler.
export async function sweepPlatformRepairPrs(deps = {}) {
  const { env = process.env, repo = PLATFORM_REPO, listOpen = listOpenPullRequestsForBase } = deps;
  if (!stagingAutomergeEnabled(env)) return { ran: false, reason: 'disabled', results: [] };
  const target = checkRepairBase(env);
  if (!target.ok) return { ran: false, reason: target.reason, results: [] };
  let prs;
  try { prs = await listOpen(repo, target.stage); } catch { return { ran: false, reason: 'github-error', results: [] }; }
  const results = [];
  for (const pr of prs) {
    if (!checkAutoMergeTarget({ base: pr.base, headRef: pr.headRef }, env).ok) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await mergePlatformRepairToStage(pr.number, deps).catch(() => refuse('error', 'unexpected error'));
    results.push({ prNumber: pr.number, ...r });
  }
  return { ran: true, results };
}
