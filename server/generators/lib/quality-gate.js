import { findScaffoldingIssues } from './content-scaffolding-guard.js';
import { findDuplicateParagraphs } from './duplicate-content-guard.js';
import { findSchemaIssues } from './schema-structure-guard.js';
import { findEmptySections } from './empty-section-guard.js';
import { checkPositioning } from './positioning-guard.js';
import { findUnverifiedLegalClaims } from './legal-fact-guard.js';
import { findUngroundedClaims } from './claim-grounding-guard.js';
import { checkDesignConsistency } from './design-consistency-gate.js';
import { checkPlaceholders } from './placeholder-guard.js';
import { findCompetitorLinks } from './outbound-link-guard.js';
import { findCompetitorProminenceIssues } from './competitor-prominence.js';
import { findDesignIntegrityIssues } from './design-integrity-guard.js';
import { findBlogImageIssues } from './blog-image-guard.js';
import { findBareMarkupIssues, findBareNewPageMarkupIssues } from './rendered-markup-guard.js';
import { checkStructureConformance } from './structure-conformance.js';
import { DESIGN_CONTEXT_GENERATOR_IDS, NO_MARKUP_GENERATOR_IDS } from '../../implementers/lib/design-drift.js';

// Only landing-page has an "offering"/CTA/capability-match concept to
// evaluate at all — every other generator (meta-title, schema, faq's Q&A
// pairs, ...) has no positioning check that would mean anything for its
// shape, so this is an opt-in list, not a blanket new stage.
const POSITIONING_CHECKED_GENERATOR_IDS = new Set(['landing-page']);

// The single Quality Gate every generator's output passes through — called
// from generateDraft() (routes/action-center.js) right after generation,
// before a draft is ever persisted, and again from approveAndPublishDraft()
// right before a submitted draft is approved/published, so a draft
// hand-edited into a bad state between those two points still gets caught.
// A future generator plugs into this automatically just by returning
// `{content, summary}` per the existing GeneratorOutput contract
// (generators/types.js) — nothing here is per-generator-registered, and no
// generator should re-implement its own scaffolding/duplicate/schema checks.
// Generators whose content is never LLM-authored prose, so the two checks
// built to catch an LLM being lazy or repeating itself don't apply and can
// only ever false-positive:
//
// - duplicate-id-fix.js's per-occurrence `snippet` is a mechanical quotation
//   of real, already-live markup, verbatim from the page it scanned. A
//   duplicate id is disproportionately likely to sit on a repeated nav/menu/
//   footer component, so its quoted snippet routinely contains real text
//   like "Toggle navigation" — content-scaffolding-guard.js's nav-leakage
//   pattern exists specifically to catch an LLM ECHOING that kind of
//   boilerplate, not a generator quoting it on purpose for a developer to
//   read (real incident, 2026-08-10: "Fix duplicate element IDs" failed
//   every single attempt).
// - geo-audit.js aggregates findings across every page on a site, and each
//   finding's recommendedAction.label is one of a handful of fixed strings
//   from geo-signals.js's GEO_SIGNAL_RULES (e.g. "Add author/byline
//   markup...") — genuinely, correctly identical across every page sharing
//   that issue, not an LLM restating itself. Any real site with the same
//   GEO gap on more than one page reliably reproduces this
//   (real incident, 2026-08-10: a full-site GEO audit failed every single
//   attempt once enough pages shared a finding type).
//
// Both generators make zero LLM calls, so generate() is pure and
// deterministic for each — a Quality Gate failure here is not the flaky,
// retry-might-fix-it case routes/action-center.js's generateDraft() error
// message implies; it's a guaranteed, permanent one. findSchemaIssues/
// findEmptySections still run unchanged for both — neither generator's
// shape matches either check's target fields anyway, so skipping them here
// would just be redundant, not additionally safe.
const NON_LLM_GENERATOR_IDS = new Set(['duplicate-id-fix', 'geo-audit']);

// Legal-content generators (cookie-policy/privacy-policy/terms-of-service)
// share compliance-draft.js's generateCompliancePage(), which already
// stores the real facts it gave the model on every draft as
// `content.factsUsed` (siteName, domain, cookiesObserved, trackersDetected)
// — see legal-fact-guard.js. This is what makes it safe to add these three
// to the auto-ship tier (agents/lib/risk-tiers.js): a draft that only uses
// real detected facts ships unattended; one that invents a service/contact
// detail fails this gate and stays open for a human, same as any other
// Quality Gate failure.
const LEGAL_FACT_CHECKED_GENERATOR_IDS = new Set(['cookie-policy', 'privacy-policy', 'terms-of-service']);

// Same "found a real, systemic exception" gap closed here as
// LEGAL_FACT_CHECKED_GENERATOR_IDS above: every content-generation
// generator's "don't invent a fact/claim/number" instruction (landing-
// page.js's "pricing, awards, client counts"; blog-outline.js's/direct-
// answer.js's "ground every claim... never invent a fact, statistic, or
// offering") was previously enforced only by asking the model nicely —
// nothing downstream checked compliance the way legal-fact-guard.js
// already does for the three legal generators. Confirmed via a
// full-codebase sweep, 2026-09-11; all three now populate
// `content.groundingContext` with the real supporting text they gave the
// model, which is what claim-grounding-guard.js checks against.
const CLAIM_GROUNDED_GENERATOR_IDS = new Set(['landing-page', 'blog-outline', 'direct-answer']);

// siteId is optional and only used by the positioning check — every
// existing caller that doesn't pass one (there are none left after this
// change, but a future one could be) simply skips it, same as a site with
// no verified capabilities does.
// Same "only where it can mean something" discipline as
// POSITIONING_CHECKED_GENERATOR_IDS above — checkDesignConsistency only
// fires for generators whose content is real, visible page content
// (design-drift.js's DESIGN_CONTEXT_GENERATOR_IDS, the same set that gets
// design/voice grounding on the way in via server/llm.js's callLLM). A
// purely technical generator's output (JSON-LD, meta values, a redirect
// rule) has no design surface to be inconsistent with.
// `site` is optional and only used by the structure-conformance check,
// which needs the site's persisted canonical page template (a plain read of
// url_file_map, no fetch of its own). Callers that already hold an
// effectiveSite snapshot — routes/action-center.js's generateDraft, which
// may have just composed that very template — pass it so the check sees the
// same template the generator was actually given. A caller with no site
// simply skips the check, exactly as before it existed.
export async function runQualityGate(content, generatorId, siteId, { site = null, enforceDesignIntegrity } = {}) {
  const isNonLlmContent = NON_LLM_GENERATOR_IDS.has(generatorId);
  const needsPositioningCheck = siteId != null && POSITIONING_CHECKED_GENERATOR_IDS.has(generatorId);
  const needsLegalFactCheck = LEGAL_FACT_CHECKED_GENERATOR_IDS.has(generatorId);
  const needsClaimGroundingCheck = CLAIM_GROUNDED_GENERATOR_IDS.has(generatorId);
  const needsDesignConsistencyCheck = DESIGN_CONTEXT_GENERATOR_IDS.has(generatorId);
  // findDesignIntegrityIssues checks the SITE's stored design profile for a
  // typography-role mismatch, not the draft's own content, so it runs for
  // every generator that can emit rendered markup/classes — a deny-list
  // (design-drift.js's NO_MARKUP_GENERATOR_IDS), not the narrower
  // DESIGN_CONTEXT_GENERATOR_IDS allowlist above: a generator like
  // content-integrity-repair or missing-page-create still touches real
  // markup even though it's outside that prose-grounding allowlist.
  const needsDesignIntegrityCheck = !NO_MARKUP_GENERATOR_IDS.has(generatorId);
  const issues = [
    ...(isNonLlmContent ? [] : findScaffoldingIssues(content, generatorId)),
    ...(isNonLlmContent ? [] : findDuplicateParagraphs(content)),
    ...findSchemaIssues(content),
    // Applies to EVERY generator, LLM-backed or not, and is deliberately not
    // scoped to a generator allow-list: an unfilled placeholder is wrong
    // wherever it appears, and the incident that prompted it (a fabricated
    // competitor table) lived in expand-content's structured `table` rows,
    // which no prose-shaped check inspects.
    ...checkPlaceholders(content).issues,
    ...findEmptySections(content),
    ...(needsPositioningCheck ? await checkPositioning(content, siteId) : []),
    ...(needsLegalFactCheck ? findUnverifiedLegalClaims(content) : []),
    ...(needsClaimGroundingCheck ? findUngroundedClaims(content) : []),
    ...(needsDesignConsistencyCheck ? checkDesignConsistency(content).issues : []),
    // Applies to EVERY generator, same "not scoped to an allow-list"
    // discipline as checkPlaceholders above — any generator could in
    // principle emit an outbound link, and the whole point of this being a
    // final safety net (rather than per-generator opt-in) is that a future
    // generator gets it for free. See outbound-link-guard.js.
    ...(await findCompetitorLinks(content, siteId)).issues,
    // The other half of the competitor policy, and same always-on scope and
    // reasoning as findCompetitorLinks above: that one catches a competitor
    // LINK (authority leakage), this one catches a competitor becoming the
    // page's SUBJECT (topical leakage) — the failure mode that shipped live on
    // a post with no competitor links at all. Mentions and comparisons stay
    // allowed; domination does not. See competitor-prominence.js.
    ...(await findCompetitorProminenceIssues(content, siteId)).issues,
    // Runs for every generator NOT in NO_MARKUP_GENERATOR_IDS — see
    // needsDesignIntegrityCheck above. See design-integrity-guard.js for the
    // log-only -> enforce rollout this implements (DESIGN_INTEGRITY_ENFORCE).
    ...(needsDesignIntegrityCheck
      ? (await findDesignIntegrityIssues(generatorId, siteId,
        enforceDesignIntegrity === undefined ? {} : { enforce: enforceDesignIntegrity })).issues
      : []),
    // A blog post generated with no featured image at all — see
    // blog-image-guard.js. Same enforceDesignIntegrity split as above: an
    // unattended/autonomous generation run should not ship one silently, a
    // human waiting on the Generate button should still see the draft.
    ...findBlogImageIssues(generatorId, content,
      enforceDesignIntegrity === undefined ? {} : { enforce: enforceDesignIntegrity }).issues,
    // Did the generator actually FOLLOW the structural guidance it was
    // given? Everything above checks the content in isolation; this is the
    // only check that compares it against this site's own canonical page
    // template. Its issues carry a `correction`, so generateDraft repairs
    // them by regenerating with that feedback rather than refusing the
    // draft — see design-repair-feedback.js.
    ...(site ? checkStructureConformance(content, generatorId, site).issues : []),
    // Renders the draft through the same buildMergeValues() call apply-time
    // splicing uses and flags any resulting block tag with no class at all
    // on a site that has real typography evidence — see rendered-markup-
    // guard.js. Gated on `site` for the same reason checkStructureConformance
    // is: it needs the site's real componentTemplates/designProfile, not
    // just siteId, and a caller with no site simply skips it, same as before.
    ...(site ? findBareMarkupIssues(
      generatorId, content, site.url_file_map?.siteRoot?.componentTemplates, site.url_file_map?.siteRoot?.designProfile,
    ).issues : []),
    // The other rendering path (whole-new-page generation) — see that
    // function's own comment for why it's a separate call rather than one
    // shared with findBareMarkupIssues above.
    ...(site ? findBareNewPageMarkupIssues(generatorId, content, site).issues : []),
  ];
  // An issue with `blocking: false` (design-integrity-guard.js's log-only
  // mode) is deliberately still visible in `issues` — it just doesn't fail
  // the gate. Every other check never sets `blocking`, so `undefined` reads
  // as blocking (the pre-existing behavior for every issue shape here).
  return { clean: !issues.some((issue) => issue.blocking !== false), issues };
}
