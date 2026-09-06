// Groups recommendations that share one underlying cause, so the run can
// prefer the fix that resolves the most problems instead of grinding through
// symptoms one slot at a time.
//
// The real backlog this was built against: 30 broken-link-fix rows over 12
// pages, NINE of them on a single page (one page with nine broken links), and
// 307 expand-content rows over only 94 pages. Processed as independent items,
// nine slots of a 60-slot day went to what is really one page's problem, and
// the ranking treated each of the nine as an unrelated low-value item.
//
// Grouping is by (generator, page) — the level at which the fixes genuinely
// share a cause and, critically, a FILE. That co-location is what makes
// running a group's members back-to-back safe: beginBatchPush opens a file
// overlay (implementers/lib/github-ops.js) so a later item in the same run
// reads the earlier item's write instead of stale branch content. Without
// that overlay, two same-file fixes in one run would each generate from the
// same base and the second would silently revert the first.
//
// Deliberately NOT a new "bundled draft" concept: each member still becomes
// its own draft, its own finding, and its own closed recommendation, so the
// existing draft/PR/verification accounting is untouched. Grouping changes
// only SELECTION ORDER and SCORING, never the unit of work.

// Recommendations with no page (blog-outline carries a topic, blog-image a
// file) are each their own group — there is no shared page-level cause to
// bundle, and lumping them together by generator alone would wrongly claim a
// breadth bonus for 143 unrelated blog topics.
export function groupKeyFor(rec) {
  const page = rec.params?.page || rec.page || null;
  if (!page) return `solo::${rec.id}`;
  return `${rec.recommendation_type}::${page}`;
}

// groupKey -> member count, for growth-scoring.js's breadth bonus.
export function groupSizes(candidates) {
  const sizes = new Map();
  for (const rec of candidates) {
    const key = groupKeyFor(rec);
    sizes.set(key, (sizes.get(key) || 0) + 1);
  }
  return sizes;
}

// How many members of one root-cause group a single run will take.
//
// Not unlimited: nine broken links on one page are worth fixing together, but
// a 40-member group would still swallow most of a day and starve every other
// page. Not one, either — taking a single member per run is exactly the
// symptom-at-a-time behaviour this module exists to end, and the same-file
// overlay makes consecutive members cheap (one shared file, one commit chain).
export const MAX_PER_GROUP_PER_RUN = 8;

/**
 * Caps every root-cause group to MAX_PER_GROUP_PER_RUN across the WHOLE
 * candidate pool, before budget selection — not just within whatever subset
 * the budget passes already picked.
 *
 * This must run BEFORE tier-floor/merit/fill selection, not after: capping
 * only the already-selected subset (the order this used to run in) silently
 * shrinks the day's queue below its budget with no backfill — confirmed on
 * real data, where a single 9-member broken-link-fix group on one page
 * pushed a 60-slot day down to 59 selected, one slot short with 556 other
 * eligible candidates sitting right there unused. Capping the whole pool
 * first means the budget passes simply never see the excess members, so
 * they naturally select `remaining` more items from what's left instead of
 * silently under-filling.
 *
 * @param scored [{ rec, score, ... }] already scored, any order
 * @returns { capped: [...scored, group-limited], deferred: [...removed], notes: string[] }
 */
export function capGroupsGlobally(scored) {
  const byGroup = new Map();
  for (const item of scored) {
    const key = groupKeyFor(item.rec);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(item);
  }

  const capped = [];
  const deferred = [];
  const notes = [];
  for (const [key, members] of byGroup) {
    if (members.length <= MAX_PER_GROUP_PER_RUN) { capped.push(...members); continue; }
    // Keep the best-scoring members, defer the rest — same "lead with the
    // strongest fix" reasoning orderByRootCause below uses for ranking.
    const sorted = [...members].sort((a, b) => b.score - a.score);
    capped.push(...sorted.slice(0, MAX_PER_GROUP_PER_RUN));
    const rest = sorted.slice(MAX_PER_GROUP_PER_RUN);
    deferred.push(...rest);
    notes.push(`${key}: ${members.length} co-located fixes exceed the ${MAX_PER_GROUP_PER_RUN}-per-group-per-run cap; keeping the ${MAX_PER_GROUP_PER_RUN} highest-scoring, deferring ${rest.length} to a later run.`);
  }
  return { capped, deferred, notes };
}

/**
 * Orders scored candidates so that a group's members run consecutively,
 * highest-scoring group first. Expects its input already respects
 * MAX_PER_GROUP_PER_RUN (i.e. drawn from capGroupsGlobally's `capped` pool) —
 * the per-group slice below is a defensive no-op in that case, not a second
 * place capping is meant to happen.
 *
 * @param scored [{ rec, score, ... }] already scored, any order
 * @returns { ordered: [...scored], deferred: [...scored], notes: string[] }
 */
export function orderByRootCause(scored) {
  const groups = new Map();
  for (const item of scored) {
    const key = groupKeyFor(item.rec);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const ranked = [...groups.entries()].map(([key, members]) => {
    // Members sorted best-first, and the group ranked by its best member: a
    // group's value is led by its strongest fix, with the breadth bonus for
    // its size already folded into every member's own score.
    const sorted = [...members].sort((a, b) => b.score - a.score);
    return { key, members: sorted, score: sorted[0].score };
  }).sort((a, b) => b.score - a.score);

  const ordered = [];
  const deferred = [];
  const notes = [];
  for (const group of ranked) {
    const take = group.members.slice(0, MAX_PER_GROUP_PER_RUN);
    const rest = group.members.slice(MAX_PER_GROUP_PER_RUN);
    ordered.push(...take);
    deferred.push(...rest);
    if (rest.length > 0) {
      notes.push(`${group.key}: taking ${take.length} of ${group.members.length} co-located fixes; ${rest.length} deferred to a later run (max ${MAX_PER_GROUP_PER_RUN} per group per run).`);
    }
  }
  return { ordered, deferred, notes };
}
