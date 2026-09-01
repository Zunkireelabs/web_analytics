import { getSiteById } from '../../store/read.js';
import { getDesignProfile, verifyProfileRoles, DESIGN_CONTEXT_GENERATOR_IDS } from '../../implementers/lib/design-drift.js';

// Wires implementers/lib/design-drift.js's verifyProfileRoles — already
// written, already tested, never called from production code before this —
// into the Quality Gate, at the exact two choke points every other check
// already runs at (generateDraft, approveAndPublishDraft, see
// quality-gate.js). Deliberately no reimplementation: verifyProfileRoles is
// the ship-gate contract design-drift.js's own comment describes as
// "Phase 5: enforcement is the LAST phase, only turned on once this has
// been run against real, already-derived profiles and shown to report true
// defects, not false positives from a thin capture sample" — this module IS
// that wiring, and DESIGN_INTEGRITY_ENFORCE below is that switch.
//
// ── How to turn enforcement on ──────────────────────────────────────────
// 1. Leave DESIGN_INTEGRITY_ENFORCE unset (the default) for a stretch of
//    real generation runs. Every role-mismatch verifyProfileRoles finds
//    still appears in the returned issue (patternId: 'design-role-mismatch',
//    `blocking: false`), visible in Action Center same as any other Quality
//    Gate finding, but does NOT fail runQualityGate's `clean` flag or block
//    a draft from shipping.
// 2. Review those logged verdicts against the actual generated content:
//    PASS should mean genuinely consistent, FAIL should mean a real,
//    visible defect (the same class used for body copy that this site's own
//    other pages use for an eyebrow/caption, etc.) — not a thin-capture
//    false positive (checkTypographyRole's own 'class-unobserved' reason is
//    already excluded from blocking below for exactly this reason; only a
//    confirmed 'role-mismatch' is reported at all).
// 3. Once verdicts are trustworthy, set DESIGN_INTEGRITY_ENFORCE=true. From
//    then on the same issue carries `blocking: true` and
//    runQualityGate.clean becomes false — the draft is refused and stays
//    open for a human to repair/retry, same as any other Quality Gate
//    failure, never silently shipped.
export function designIntegrityEnforced() {
  return process.env.DESIGN_INTEGRITY_ENFORCE === 'true';
}

/**
 * @returns {{issues: Array<{path, patternId, snippet, detail, blocking}>}}
 * Same shape every sibling guard returns to runQualityGate. siteId/
 * generatorId are required — with either missing (a generator with no site
 * context, or one outside DESIGN_CONTEXT_GENERATOR_IDS, the same visible-
 * content set withDesignContext already scopes to), this is a no-op.
 */
export async function findDesignIntegrityIssues(generatorId, siteId, { fetchSite = getSiteById } = {}) {
  if (!generatorId || !siteId || !DESIGN_CONTEXT_GENERATOR_IDS.has(generatorId)) return { issues: [] };

  let site;
  try {
    site = await fetchSite(siteId);
  } catch (err) {
    console.warn(`[design-integrity-guard] could not load site ${siteId}, skipping: ${err.message}`);
    return { issues: [] };
  }

  const profile = getDesignProfile(site);
  if (!profile) return { issues: [] };

  const verdict = verifyProfileRoles(profile);
  if (verdict.ok) return { issues: [] };

  const blocking = designIntegrityEnforced();
  return {
    issues: [{
      path: verdict.field,
      patternId: 'design-role-mismatch',
      snippet: verdict.classes.slice(0, 120),
      detail: `${verdict.error} This generator's output would render using that same mismatched styling.`,
      blocking,
    }],
  };
}
