// Pure, deterministic generator — no LLM call, no live re-fetch. The
// accessibility agent (server/agents/accessibility.js) already captured
// everything needed at scan time: which id values repeat, on which tags,
// with a short real-markup snippet per occurrence (page-content.js's
// duplicateIds). This generator just turns that into a reviewable,
// per-occurrence fix plan.
//
// Deliberately advisory, not an auto-applied file diff: renaming an id
// safely requires knowing every CSS selector (#id), JS call
// (getElementById/querySelector), and anchor link (#id) that references it
// — none of which a static single-page fetch can see with confidence.
// Blindly rewriting one occurrence risks silently breaking styling or
// behavior elsewhere. Same posture as geo-audit.js (a report for a human,
// not a mergeable patch) — no implementer is registered for this
// generatorId, so it never appears in the Execute Safe Fixes auto-chain
// (risk-tiers.js defaults any unlisted generatorId to 'manual' tier) and
// stays a draft for a developer to act on directly in their own repo.

export const meta = {
  id: 'duplicate-id-fix',
  name: 'Duplicate ID Fix Plan',
  description: 'Produces a per-occurrence fix plan for duplicate id attributes found on a page — which element to keep, which to rename, and to what — for a developer to apply by hand.',
  recommendationTags: ['accessibility', 'duplicate id'],
};

// First occurrence keeps its id (usually the "original" use); every
// later one gets a numbered suffix. Simple and predictable — a developer
// reviewing the plan can immediately see the rule, and re-running this
// generator on the same input always proposes the same renames.
function buildFixPlan(duplicateIds) {
  return (duplicateIds || []).map(({ id, count, occurrences }) => ({
    id,
    count,
    occurrences: (occurrences || []).map((occ, i) => ({
      tag: occ.tag,
      snippet: occ.snippet,
      keep: i === 0,
      suggestedId: i === 0 ? id : `${id}-${i + 1}`,
    })),
  }));
}

export async function generate({ params }) {
  const page = params?.page;
  const duplicateIds = params?.duplicateIds || [];
  const fixPlan = buildFixPlan(duplicateIds);
  const totalOccurrences = fixPlan.reduce((sum, f) => sum + f.count, 0);

  return {
    content: {
      page,
      fixPlan,
      instructions: 'For each id below, keep the first occurrence as-is and rename every other occurrence to its suggested id — then update any CSS selector, ' +
        'JS getElementById/querySelector call, or #anchor link that pointed at the old shared id so it still resolves to the right element. ' +
        'Verify in the browser (or with the site\'s own test suite) before shipping — this plan is a starting point, not a verified-safe diff.',
    },
    summary: `${fixPlan.length} duplicate id${fixPlan.length === 1 ? '' : 's'} (${totalOccurrences} total occurrences) on ${page || 'this page'} — fix plan drafted for manual review.`,
  };
}
