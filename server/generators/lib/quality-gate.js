import { findScaffoldingIssues } from './content-scaffolding-guard.js';
import { findDuplicateParagraphs } from './duplicate-content-guard.js';
import { findSchemaIssues } from './schema-structure-guard.js';
import { findEmptySections } from './empty-section-guard.js';

// The single Quality Gate every generator's output passes through — called
// from generateDraft() (routes/action-center.js) right after generation,
// before a draft is ever persisted, and again from approveAndPublishDraft()
// right before a submitted draft is approved/published, so a draft
// hand-edited into a bad state between those two points still gets caught.
// A future generator plugs into this automatically just by returning
// `{content, summary}` per the existing GeneratorOutput contract
// (generators/types.js) — nothing here is per-generator-registered, and no
// generator should re-implement its own scaffolding/duplicate/schema checks.
// Generators whose content is never LLM-authored prose — it's a mechanical
// quotation of real, already-live markup (e.g. duplicate-id-fix.js's
// per-occurrence `snippet`, verbatim from the page it scanned), so the two
// checks built to catch an LLM being lazy or repeating itself don't apply
// and can only ever false-positive: a duplicate id is disproportionately
// likely to sit on a repeated nav/menu/footer component, so its quoted
// snippet routinely contains real text like "Toggle navigation" —
// content-scaffolding-guard.js's nav-leakage pattern exists specifically to
// catch an LLM ECHOING that kind of boilerplate, not a generator quoting it
// on purpose for a developer to read. Since this generator makes zero LLM
// calls, generate() is pure and deterministic — a Quality Gate failure here
// is not the flaky, retry-might-fix-it case routes/action-center.js's
// generateDraft() error message implies; it's a guaranteed, permanent one
// (real incident, 2026-08-10: "Fix duplicate element IDs" failed every
// single attempt). findSchemaIssues/findEmptySections still run unchanged —
// this generator's shape doesn't match either's target fields anyway, so
// skipping them here would just be redundant, not additionally safe.
const DETERMINISTIC_MARKUP_GENERATOR_IDS = new Set(['duplicate-id-fix']);

export function runQualityGate(content, generatorId) {
  const quotesRealMarkupOnly = DETERMINISTIC_MARKUP_GENERATOR_IDS.has(generatorId);
  const issues = [
    ...(quotesRealMarkupOnly ? [] : findScaffoldingIssues(content, generatorId)),
    ...(quotesRealMarkupOnly ? [] : findDuplicateParagraphs(content)),
    ...findSchemaIssues(content),
    ...findEmptySections(content),
  ];
  return { clean: issues.length === 0, issues };
}
