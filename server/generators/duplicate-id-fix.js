// Pure, deterministic generator — no LLM call, no live re-fetch. The
// accessibility agent (server/agents/accessibility.js) already captured
// everything needed at scan time: which id values repeat, on which tags,
// with a short real-markup snippet per occurrence (page-content.js's
// duplicateIds). This generator just turns that into a reviewable,
// per-occurrence fix plan.
//
// Deliberately advisory for the general case, not an auto-applied file
// diff: renaming an id safely requires knowing every CSS selector (#id), JS
// call (getElementById/querySelector), and anchor link (#id) that
// references it — none of which a static single-page fetch can see with
// confidence. Blindly rewriting one occurrence risks silently breaking
// styling or behavior elsewhere.
//
// backend.js DOES register an implementer for this generatorId, but it only
// auto-applies one provably-safe shape: a duplicate id on an SVG
// linearGradient/radialGradient/clipPath/mask that's referenced solely by
// url(#id) inside its own <svg> block (see
// implementers/lib/duplicate-id-inject.js) — no cross-file or cross-CSS/JS
// blast radius to reason about. Every other occurrence in the plan still
// refuses and falls back to this advisory draft, all-or-nothing per draft.
// risk-tiers.js still defaults this generatorId to 'manual' tier (it's not
// in SAFE_GENERATOR_IDS), so it never enters the Execute Safe Fixes
// auto-chain even for the safe shape — a human still reviews and clicks
// Apply per draft, same as geo-audit.js's posture, just no longer a dead
// end when they do.

import { analyzePageUrl } from '../agents/lib/page-content.js';

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

// Side-effect-free re-verification (server/generators/lib/verification-layer.js).
// Re-runs the exact same real check accessibility.js used to detect this
// (page-content.js's analyzePage, via analyzePageUrl) against the live page
// right now, rather than trusting the params captured whenever the finding
// was first detected. already_resolved only once EVERY id this recommendation
// named is no longer duplicated — a page can pick up a fresh duplicate on the
// same id count between detection and drafting (a template edit, an A/B
// variant), which analyzePage would surface as a genuinely different set.
export async function verifyCurrentState(rec, { site } = {}) {
  const page = rec.params?.page || rec.page;
  const namedIds = (rec.params?.duplicateIds || []).map((d) => d.id);
  if (!page || !namedIds.length) return { decision: 'still_valid', reason: 'missing-params', evidence: null };

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) return { decision: 'still_valid', reason: 'unreachable', evidence: { page, error: fetched.error } };

  const stillDuplicated = new Set((fetched.analysis.duplicateIds || []).map((d) => d.id));
  const remaining = namedIds.filter((id) => stillDuplicated.has(id));
  if (remaining.length === 0) {
    return { decision: 'already_resolved', reason: 'no-longer-duplicated', evidence: { page, checked: namedIds } };
  }
  return { decision: 'still_valid', reason: 'still-duplicated', evidence: { page, remaining } };
}
