// THE THREE SEPARATE FACTS about a change that has a pull request (migration 271), and what to call a change in each:
//   pr_opened            the PR exists and is waiting for a person
//   human_merged         GitHub reports a PERSON merged it (merged_by_type 'User')
//   production_verified  the fix-verification job re-read the LIVE page and the change is there
// plus the honest in-betweens: merged_by_bot (an app merged it: this system never merges, so that is an anomaly), merged_unattributed (merged before who-merged
// was recorded, or GitHub did not say), merged_unverified (a person merged it and it is not confirmed live), pr_closed (closed without merging), no_pr.
// "Done" in the Zunkireelabs workflow means live in production, so only production_verified counts as done.
import { query as defaultQuery } from '../db.js';

export const LIFECYCLE = Object.freeze({
  NO_PR: 'no_pr', PR_OPENED: 'pr_opened', PR_CLOSED: 'pr_closed', HUMAN_MERGED: 'human_merged', MERGED_BY_BOT: 'merged_by_bot',
  MERGED_UNATTRIBUTED: 'merged_unattributed', PRODUCTION_VERIFIED: 'production_verified',
});

/** Pure. Where one draft stands. Reads only the recorded facts; guesses nothing. */
export function lifecycleOf(d) {
  if (!d || d.pr_number == null) return LIFECYCLE.NO_PR;
  if (d.merged_at) {
    if (d.production_verified_at) return LIFECYCLE.PRODUCTION_VERIFIED;
    if (d.merged_by_type === 'User') return LIFECYCLE.HUMAN_MERGED;
    if (d.merged_by_type) return LIFECYCLE.MERGED_BY_BOT;
    return LIFECYCLE.MERGED_UNATTRIBUTED;
  }
  if (d.pr_state === 'closed' && d.status === 'abandoned') return LIFECYCLE.PR_CLOSED;
  if (d.pr_state === 'closed') return LIFECYCLE.PR_CLOSED;
  return LIFECYCLE.PR_OPENED;
}

/** Pure. Counts per state plus the drafts that need a person or an alert. `now` and `staleDays` decide what "merged but never verified live" means. */
export function summarizeLifecycle(drafts, { now = new Date(), staleDays = 3 } = {}) {
  const counts = Object.fromEntries(Object.values(LIFECYCLE).map((v) => [v, 0]));
  const mergedBot = []; const mergedUnverified = []; const waitingForReview = [];
  for (const d of drafts) {
    const s = lifecycleOf(d); counts[s] += 1;
    if (s === LIFECYCLE.MERGED_BY_BOT) mergedBot.push(d);
    if (s === LIFECYCLE.HUMAN_MERGED && d.merged_at && now - new Date(d.merged_at) > staleDays * 86_400_000) mergedUnverified.push(d);
    if (s === LIFECYCLE.PR_OPENED) waitingForReview.push(d);
  }
  return { counts, mergedBot, mergedUnverified, waitingForReview };
}

const FIELDS = `id, site_id, action_type, finding_id, status, pr_number, pr_url, pr_state, branch_name, merged_by, merged_by_type, merged_at, production_verified_at, updated_at`;

/** One project's drafts that have (or had) a pull request in the last `days` days. */
export async function listLifecycleDrafts(siteId, { days = 14, query = defaultQuery } = {}) {
  const { rows } = await query(
    `SELECT ${FIELDS} FROM drafts WHERE site_id = $1 AND pr_number IS NOT NULL AND (updated_at > now() - ($2::int * interval '1 day') OR merged_at > now() - ($2::int * interval '1 day')) ORDER BY id DESC LIMIT 500`,
    [siteId, days]);
  return rows;
}
