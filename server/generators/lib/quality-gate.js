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
export function runQualityGate(content, generatorId) {
  const issues = [
    ...findScaffoldingIssues(content, generatorId),
    ...findDuplicateParagraphs(content),
    ...findSchemaIssues(content),
    ...findEmptySections(content),
  ];
  return { clean: issues.length === 0, issues };
}
