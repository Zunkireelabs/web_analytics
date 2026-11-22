import { mergeStagePr } from './ship-flow.js';
import { commentOnPullRequest, getPullRequest } from '../github/client.js';

// "The approver said OK, so the agent merges into STAGE." This turns an approval MESSAGE (a GitHub PR comment or an approving review from
// a person the client named) into the same guarded stage merge a signed-in person's button runs (lib/ship-flow.js mergeStagePr), then
// asks for the promotion PR to main. Rules, each with a refusal code:
//   manual-site     the site is review-first (Mobilise): its team approves and merges by hand, never by a message
//   not-approver    the commenter is not on the site's own approvers list (url_file_map.approvers, GitHub logins) — ignored silently
//   not-approval    the text is not a plain approval (a question, "not ok", "ok but ...")
//   <ship-flow>     any mergeStagePr guard: no stage, not open, not stage, conflicts, checks pending/failed, no checks at all
// MAIN IS NEVER MERGED HERE. The promotion PR it asks for contains only the reviewed batch (lib/stage-promotion.js) and a person merges it.

const APPROVE = /^(ok|okay|approved?|lgtm|looks good( to me)?|go ahead|ship it|merge it|yes|yep|👍|✅)$/i;

export function isApprovalText(text) {
  const t = String(text || '').trim().replace(/[.!\s]+$/g, '').replace(/^[\s>*_`]+|[\s*_`]+$/g, '');
  return t.length > 0 && t.length <= 40 && APPROVE.test(t);
}

export function approversOf(site) {
  const list = site?.url_file_map?.approvers;
  return Array.isArray(list) ? list.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
}

export async function handleApprovalSignal(site, prNumber, { actor, via, text = null, reviewState = null } = {}, deps = {}) {
  const { merge = mergeStagePr, comment = commentOnPullRequest, syncDrafts = async () => {}, promote = async () => null, readPr = getPullRequest } = deps;
  const refuse = (reason, message) => ({ ok: false, reason, message });
  if (!site) return refuse('no-site', 'Unknown site.');
  if (site.ship_mode === 'review-first') return refuse('manual-site', 'This site is approved and merged by its own team by hand.');
  if (!actor || !approversOf(site).includes(String(actor).toLowerCase())) return refuse('not-approver', 'Not a named approver for this site.');
  const approving = reviewState ? String(reviewState).toLowerCase() === 'approved' : isApprovalText(text);
  if (!approving) return refuse('not-approval', 'Not a plain approval.');

  // Only the agent's own batch PRs are eligible: the PR must be one the platform opened (it lists drafts on it), not an arbitrary PR.
  let pr;
  try { pr = await readPr(site, prNumber); } catch { return refuse('github-error', 'GitHub could not be reached, so nothing was done.'); }
  if (!pr || pr.state !== 'open' || pr.merged) return refuse('not-open', 'That pull request is not open.');
  if (!(await (deps.isAgentPr ? deps.isAgentPr(site, prNumber) : true))) return refuse('not-agent-pr', 'That pull request was not opened by the agent.');

  const r = await merge(site, prNumber, { userId: `${via || 'approval'}:${actor}`, requireChecks: true });
  if (!r.ok) {
    await comment(site, prNumber, `Approval from @${actor} received, but this was **not merged**: ${r.message || r.reason}. It stays open for a person.`).catch(() => {});
    return r;
  }
  await comment(site, prNumber, `Approved by @${actor}. Merged into \`${r.base}\` (the repository's checks passed). A promotion PR to the main branch will follow for a person to merge.`).catch(() => {});
  await syncDrafts(site.id, prNumber).catch(() => {});
  const promoted = await promote(site.id).catch(() => null);
  return { ...r, merged: true, promotion: promoted };
}
