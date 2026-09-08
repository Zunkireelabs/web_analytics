// STRUCTURE CONFORMANCE — the "did the generator actually FOLLOW the
// structural guidance it was given" check that design-aware-composer.js's
// pageStructureGuidance never had.
//
// pageStructureGuidance (and page-templates.js's canonical template behind
// it) tells a generator, in its prompt, what shape this site's own real
// pages of that type take. Nothing afterwards ever re-read the generated
// content to see whether it complied — the guidance was purely advisory, so
// a model that ignored it (or answered with a shape from a different page
// type entirely) produced a page that structurally did not belong to the
// site, and nothing downstream noticed.
//
// GROUNDING RULE, same as every sibling guard: this only ever compares
// against a REAL persisted canonical template for this site (composed or
// inferred by page-templates.js). No canonical template -> nothing to
// conform to -> no issues. It never invents an expected shape, and it never
// fails a page for a template the site does not actually have.
//
// NOT A REJECTION MECHANISM. Every issue carries a `correction` — a plain
// instruction naming what to change — because routes/action-center.js's
// generation loop feeds these back to the generator for a bounded, real
// repair attempt rather than refusing the draft outright. Blocking is only
// what happens after repair has genuinely been tried and failed.
import { PAGE_TEMPLATE_TYPES_FOR_GENERATOR } from '../../design-agent/lib/page-templates.js';

// A generated page is not required to mirror the canonical section count
// exactly — a real topic legitimately needs more or fewer sections than the
// page the template was captured from, and forcing parity would make this
// guard fight the content rather than the design. What it does catch is a
// page that is structurally nothing like the site's own: a canonical shape
// of 6 sections answered with 1, or with 20.
const MIN_SECTION_RATIO = 0.5;
const MAX_SECTION_RATIO = 2.5;

// Below this there is no meaningful "shape" to conform to — a 1-2 section
// canonical template describes almost any page, so ratio-checking against it
// would produce noise, not signal.
const MIN_CANONICAL_SECTIONS = 3;

function canonicalTemplateFor(site, generatorId) {
  const candidateTypes = PAGE_TEMPLATE_TYPES_FOR_GENERATOR[generatorId];
  if (!candidateTypes) return null;
  const templates = site?.url_file_map?.siteRoot?.pageTemplates;
  if (!templates || typeof templates !== 'object') return null;
  for (const type of candidateTypes) {
    const t = templates[type];
    if (t && (t.sectionOrder?.length || t.textRoles?.length)) return t;
  }
  return null;
}

function sectionsOf(content) {
  return Array.isArray(content?.sections) ? content.sections : null;
}

/**
 * @returns {{issues: Array<{path, patternId, snippet, detail, correction}>}}
 * Same shape every other Quality Gate guard returns, plus `correction`.
 */
export function checkStructureConformance(content, generatorId, site) {
  const template = canonicalTemplateFor(site, generatorId);
  if (!template) return { issues: [] };

  const sections = sectionsOf(content);
  if (!sections) return { issues: [] }; // not a sectioned generator's shape — nothing to compare

  const issues = [];
  const expected = template.sectionOrder?.length || 0;
  const actual = sections.length;

  if (expected >= MIN_CANONICAL_SECTIONS && actual > 0) {
    const ratio = actual / expected;
    if (ratio < MIN_SECTION_RATIO || ratio > MAX_SECTION_RATIO) {
      issues.push({
        path: 'sections',
        patternId: 'structure-section-count',
        snippet: `${actual} section(s)`,
        detail: `This site's own "${template.pageType}" pages are built from ${expected} sections (${template.sectionOrder.join(' -> ')}), but this draft has ${actual}.`,
        correction: `Restructure the content into roughly ${expected} sections, following this site's real "${template.pageType}" section order: ${template.sectionOrder.join(' -> ')}. Keep all the substance you already wrote — regroup and retitle it to fit that shape rather than deleting content or padding with filler.`,
      });
    }
  }

  // A section with no heading has no place in an ordered structure at all —
  // every canonical template this compares against is expressed as an
  // ORDER of named sections, so an unnamed one cannot occupy a position in
  // it. Deliberately separate from empty-section-guard.js, which checks for
  // a missing BODY.
  const unheaded = sections.filter((s) => !s?.heading || !String(s.heading).trim());
  if (unheaded.length) {
    issues.push({
      path: 'sections[].heading',
      patternId: 'structure-missing-heading',
      snippet: `${unheaded.length} section(s) with no heading`,
      detail: `${unheaded.length} section(s) have no heading, so they cannot occupy a position in this site's "${template.pageType}" section order.`,
      correction: 'Give every section a real, descriptive heading — never an empty string or placeholder.',
    });
  }

  return { issues };
}
