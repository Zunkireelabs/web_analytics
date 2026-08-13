import { findScaffoldingIssues } from './content-scaffolding-guard.js';
import { findDuplicateParagraphs } from './duplicate-content-guard.js';
import { findSchemaIssues } from './schema-structure-guard.js';
import { findEmptySections } from './empty-section-guard.js';
import { checkPositioning } from './positioning-guard.js';

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

// siteId is optional and only used by the positioning check — every
// existing caller that doesn't pass one (there are none left after this
// change, but a future one could be) simply skips it, same as a site with
// no verified capabilities does.
export async function runQualityGate(content, generatorId, siteId) {
  const isNonLlmContent = NON_LLM_GENERATOR_IDS.has(generatorId);
  const needsPositioningCheck = siteId != null && POSITIONING_CHECKED_GENERATOR_IDS.has(generatorId);
  const issues = [
    ...(isNonLlmContent ? [] : findScaffoldingIssues(content, generatorId)),
    ...(isNonLlmContent ? [] : findDuplicateParagraphs(content)),
    ...findSchemaIssues(content),
    ...findEmptySections(content),
    ...(needsPositioningCheck ? await checkPositioning(content, siteId) : []),
  ];
  return { clean: issues.length === 0, issues };
}
