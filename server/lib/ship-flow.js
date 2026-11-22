import { getPullRequest, getCheckRunsForRef, mergePullRequest, prTargetBranchName, defaultBranchName } from '../github/client.js';

// The shipping flow the client sees as one card. Nothing here is a to-do list: the step is worked out from the drafts and PRs
// themselves every time, so it cannot drift from what is really on GitHub. In order:
//   push_branch  every draft is decided and some are approved: "put them on today's branch as ONE commit?" (commit and push, no PR yet)
//   open_pr      the commit is on the branch: "open the PR?" (to stage when the site has one)
//   merge_stage  the PR to the STAGE branch is open: "merge it?"                (only on a site that has a stage branch)
//   open_main    stage is merged: "open the PR to main?"                          (opens only; a person merges main)
//   waiting      a PR to main is open: a person reviews and merges it on GitHub (no button here can merge main)
// It does not ask while anything is still waiting for the client: they finish approving first. A site with no stage branch has no
// merge_stage: its PR goes to main and waits for a person.

// The stage branch of a site, or null when it has none (a PR then goes straight to main).
export function stageBranchOf(site) {
  const stage = prTargetBranchName(site);
  return stage && stage !== defaultBranchName(site) ? stage : null;
}

export function shipStep({ drafts = [], site, promotions = [] } = {}) {
  const stage = stageBranchOf(site);
  const by = (fn) => drafts.filter(fn);
  const approved = by((d) => d.status === 'approved');
  const undecided = by((d) => ['draft', 'edited', 'submitted_for_approval', 'revision_requested'].includes(d.status));
  const pushed = by((d) => d.status === 'branch_pushed');
  const openPrs = by((d) => d.status === 'pr_opened');
  // A PR into stage that GitHub reports merged keeps status 'pr_opened' (it is not live) with pr_state 'merged'.
  const isStagePr = (d) => stage && d.status === 'pr_opened' && d.pr_base_branch === stage;
  const toStage = openPrs.filter((d) => isStagePr(d) && d.pr_state !== 'merged');
  const toMain = stage ? openPrs.filter((d) => d.pr_base_branch !== stage) : openPrs;
  const onStage = by((d) => d.status === 'merged_to_stage' || (isStagePr(d) && d.pr_state === 'merged'));
  const promo = promotions.find((p) => p.status === 'opened' && p.promotion_pr_number);

  if (approved.length && !undecided.length) return { step: 'push_branch', count: approved.length, hasStage: Boolean(stage) };
  if (pushed.length) return { step: 'open_pr', count: pushed.length, hasStage: Boolean(stage) };
  if (toStage.length) return { step: 'merge_stage', count: toStage.length, prNumber: toStage[0].pr_number, prUrl: toStage[0].pr_url || null, hasStage: true };
  if (onStage.length && !promo) return { step: 'open_main', count: onStage.length, hasStage: true };
  if (promo) return { step: 'waiting', count: onStage.length || 1, prNumber: promo.promotion_pr_number, prUrl: promo.promotion_pr_url || null, hasStage: true };
  if (toMain.length) return { step: 'waiting', count: toMain.length, prNumber: toMain[0].pr_number, prUrl: toMain[0].pr_url || null, hasStage: Boolean(stage) };
  return { step: null, count: 0, hasStage: Boolean(stage) };
}

const refuse = (reason, error) => ({ ok: false, reason, error });
const GOOD = new Set(['success', 'neutral', 'skipped']);

// Merge a pull request into the STAGE branch, on a person's say-so. Every guard below must pass or nothing is merged, and the reason is
// returned so the screen can say it plainly:
//   no-person      nobody signed in asked for this (an agent, a job or a script can never reach a merge)
//   no-stage       the site has no stage branch, so there is nothing safe to merge into
//   github-error   GitHub could not be reached or did not answer, so nothing was done
//   not-open       the PR is closed or merged already
//   not-stage      the PR does not target the stage branch (main is never merged from here)
//   checks-pending / checks-failed   the repository's own checks have not all passed
//   no-checks      (only when requireChecks is set) the repository ran no automated check at all
//   conflicts      GitHub says it cannot merge cleanly
// `deps` are injectable so this is tested with fakes and never touches GitHub.
export async function mergeStagePr(site, prNumber, { userId, requireChecks = false } = {}, deps = {}) {
  const { getPr = getPullRequest, getChecks = getCheckRunsForRef, merge = mergePullRequest } = deps;
  if (!userId) return refuse('no-person', 'A merge needs a signed-in person to ask for it.');
  const stage = stageBranchOf(site);
  if (!stage) return refuse('no-stage', 'This site has no stage branch, so there is nothing safe to merge into. The PR waits for a person on GitHub.');
  let pr;
  try { pr = await getPr(site, prNumber); } catch (e) { console.error('[ship-flow] could not read the pull request:', e.message); return refuse('github-error', 'GitHub could not be reached just now, so nothing was merged.'); }
  if (!pr || pr.state !== 'open' || pr.merged) return refuse('not-open', 'That pull request is not open.');
  if (pr.base !== stage) return refuse('not-stage', `That pull request goes to "${pr.base}", not the stage branch. Only stage is merged from here; main is merged by a person on GitHub.`);
  if (pr.mergeable === false) return refuse('conflicts', 'GitHub says this cannot be merged cleanly yet.');
  let checks = [];
  try { checks = await getChecks(site, pr.headSha); } catch (e) { console.error('[ship-flow] could not read the checks:', e.message); return refuse('checks-pending', 'The checks could not be read yet, so nothing was merged. Try again in a minute.'); }
  // requireChecks: an approval that arrives as a message (not a button press on the stage preview) is only honoured when the repository's own
  // build/check actually ran. A repo with no checks at all is never merged automatically — a person looks at it.
  if (requireChecks && checks.length === 0) return refuse('no-checks', 'No automated check ran on this change, so it was not merged automatically. A person merges it after looking at it.');
  if (checks.some((c) => c.status !== 'completed')) return refuse('checks-pending', 'The checks are still running.');
  if (checks.some((c) => !GOOD.has(c.conclusion))) return refuse('checks-failed', 'A check failed, so it was not merged.');
  const out = await merge(site, prNumber, { sha: pr.headSha });
  if (!out.merged) return refuse('not-merged', 'GitHub did not merge it.');
  return { ok: true, sha: out.sha, base: stage };
}
