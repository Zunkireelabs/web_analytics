// ROUTING A DESIGN MISMATCH TO THE THING THAT CAN ACTUALLY FIX IT.
//
// The repair loop in routes/action-center.js regenerates content with a
// correction appended to the prompt, which is the right repair for a
// mismatch that lives IN the generated content (wrong section count, a
// section with no heading — see structure-conformance.js).
//
// A `design-role-mismatch` is NOT that. design-drift.js's verifyProfileRoles
// reads the SITE'S STORED DESIGN PROFILE and nothing else: it asks whether
// e.g. typography.body names a class this site only ever uses for its
// eyebrow/CTA. The generated draft is not an input to that question, so
// regenerating the draft — however many times, with whatever feedback —
// cannot possibly change the answer. Left to the content loop alone, such a
// mismatch burns every attempt and then blocks, which is precisely the
// "hand a normal design problem to a human" outcome the loop exists to
// avoid.
//
// The repair that DOES fix it already exists and is deterministic:
// scripts/repair-design-profile-roles.js's role correction, which re-decides
// which captured class belongs in which role slot from the profile's own
// stored evidence — no network, no model call, and idempotent, so running it
// on an already-correct profile reports no change rather than churning.
//
// So this module is the DIAGNOSE -> ROUTE step: given the gate's issues, it
// decides which repairer applies and runs it, returning a refreshed site so
// the next attempt is validated against the corrected profile.

export const DESIGN_ROLE_MISMATCH_PATTERN = 'design-role-mismatch';

/**
 * Does this set of gate issues contain something only a PROFILE repair can
 * fix? Kept as its own predicate so the caller can decide to spend a repair
 * attempt without knowing how the repair works.
 */
export function hasProfileLevelMismatch(issues) {
  return (issues || []).some((i) => i?.patternId === DESIGN_ROLE_MISMATCH_PATTERN);
}

/**
 * Runs the deterministic design-profile role correction for ONE site and
 * hands back a freshly-read site so the caller's next validation sees the
 * corrected profile.
 *
 * Deliberately best-effort: a repair that throws, or that changes nothing,
 * returns `{repaired: false}` and the caller simply proceeds to its normal
 * bounded-attempt behavior. A failure to self-heal must never be louder than
 * the original problem.
 *
 * @returns {Promise<{repaired: boolean, site: object|null}>}
 */
export async function repairProfileLevelMismatch(siteId, { repairSites, fetchSite, loadSiteRow } = {}) {
  if (!siteId || !repairSites || !fetchSite || !loadSiteRow) return { repaired: false, site: null };
  try {
    // The repair reads whichever of the site's URL columns is populated, so
    // it needs the full row — a narrowed projection silently makes every
    // template "unreachable" and the whole repair a no-op that reports
    // success (see repair-design-profile-roles.js's own note on `select *`).
    const row = await loadSiteRow(siteId);
    if (!row) return { repaired: false, site: null };

    const result = await repairSites([row], { commit: true });
    if (!result?.changed) return { repaired: false, site: null };

    // Re-read so the corrected profile is what the next attempt validates
    // against; without this the loop would re-check the stale in-memory copy
    // and conclude the repair did nothing.
    return { repaired: true, site: await fetchSite(siteId) };
  } catch (err) {
    console.error(`[design-mismatch-repair] profile role repair failed for site ${siteId}: ${err.message}`);
    return { repaired: false, site: null };
  }
}
