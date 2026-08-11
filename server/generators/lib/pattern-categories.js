// Maps a Quality Gate patternId (content-scaffolding-guard.js,
// duplicate-content-guard.js, schema-structure-guard.js,
// empty-section-guard.js) to a human-readable issue category + root cause —
// shared by generateDraft's self-correction lesson recording and
// draft-lesson-extraction.js's human-edit lesson recording, so both write
// the SAME vocabulary into fix_lessons instead of two ad hoc label sets
// that could never be queried/aggregated together.

const PATTERN_INFO = {
  'todo-marker': { category: 'scaffolding', rootCause: 'The model left an unfinished TODO/TBD/FIXME marker in place of real content.' },
  'lorem-ipsum': { category: 'scaffolding', rootCause: 'The model emitted placeholder lorem-ipsum text instead of real, grounded content.' },
  'placeholder-bracket': { category: 'scaffolding', rootCause: 'The model left an "[Insert X here]"-style instruction bracket instead of real content.' },
  'template-braces': { category: 'scaffolding', rootCause: 'The model left an unfilled template variable (e.g. "{{city}}") instead of a real value.' },
  'outline-heading': { category: 'scaffolding', rootCause: 'The model wrote outline-style section numbering ("Section 1:") as if it were real body copy.' },
  'instructional-filler': { category: 'scaffolding', rootCause: 'The model wrote a meta-instruction ("write an introduction here") instead of the actual introduction.' },
  'llm-meta-commentary': { category: 'llm-leakage', rootCause: 'The model referred to itself as an AI instead of writing in the site\'s voice.' },
  'llm-refusal': { category: 'llm-leakage', rootCause: 'The model refused or hedged instead of completing the draft.' },
  'nav-leakage': { category: 'nav-leakage', rootCause: 'Navigation/footer boilerplate text leaked into generated body copy.' },
  'author-placeholder': { category: 'author-attribution', rootCause: 'No real site author profile was configured, so the model fell back to a "[Author Name]" placeholder byline.' },
  'duplicate-paragraph': { category: 'duplicate-content', rootCause: 'The model repeated the same paragraph in two places instead of writing distinct content for each.' },
  'schema-missing-context': { category: 'schema-validity', rootCause: 'The drafted JSON-LD omitted "@context": "https://schema.org".' },
  'schema-missing-type': { category: 'schema-validity', rootCause: 'The drafted JSON-LD omitted "@type".' },
  'schema-missing-required-field': { category: 'schema-validity', rootCause: 'The drafted JSON-LD was missing a field Google\'s guidelines require for that @type.' },
  'empty-section': { category: 'empty-content', rootCause: 'The model returned an empty or non-answer body/answer for a section it claimed to have written.' },
};

export function categoryForPattern(patternId) {
  return PATTERN_INFO[patternId]?.category || 'content-correction';
}

export function rootCauseForPattern(patternId) {
  return PATTERN_INFO[patternId]?.rootCause || null;
}

// Coarse generatorId -> agent_fix_memory top-level category split (migration
// 097 constrains category to a fixed enum, unlike fix_lessons' free-text
// category column). 'technical-seo' is generators fixing markup/config
// correctness (schema validity, headers, redirects, crawlability); anything
// that's primarily generating on-page written content defaults to
// 'content'. Shared by generateDraft's self-correction/human-edit lesson
// recording (server/routes/action-center.js) and the one-time fix_lessons
// backfill (server/scripts/migrate-fix-lessons-to-memory.js) so both use the
// exact same split.
const TECHNICAL_SEO_GENERATORS = new Set([
  'schema', 'schema-repair', 'security-headers', 'robots-fix', 'redirect-fix',
  'canonical', 'sitemap', 'html-lang', 'viewport', 'internal-links',
  'llms-txt', 'broken-link-fix', 'analytics-install', 'duplicate-id-fix', 'open-graph',
]);

export function topLevelCategoryForGenerator(generatorId) {
  return TECHNICAL_SEO_GENERATORS.has(generatorId) ? 'technical-seo' : 'content';
}
