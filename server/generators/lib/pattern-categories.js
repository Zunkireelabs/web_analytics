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

// The one thing a generator can actually ACT on next time, as opposed to
// being told what went wrong. agent-memory.js's withAgentMemory only inlines
// a lesson's fix_pattern into a generator's prompt ("Fix: ...") once that
// lesson has been promoted to execution_permission='auto'; without a
// fix_pattern it can only ever render the advisory form ("...[advisory — do
// not repeat this]").
//
// Before this existed, ZERO of the 58 rows in agent_fix_memory had a
// fix_pattern, so that branch was unreachable dead code and every lesson the
// platform had ever learned reached a prompt as a warning rather than as a
// correction.
//
// Deliberately scoped to Quality Gate patterns and nothing else. These are
// the only lessons whose fix is genuinely client-agnostic: the rule for
// "don't leave a TODO marker" is identical for every tenant, so it is safe on
// a cross-tenant row. The fix for a content lesson learned from a human's
// edit is NOT — it is that client's own copy, which must never be replayed
// into another client's prompt (see draft-lesson-extraction.js). Those stay
// advisory on purpose, and that is a correctness decision rather than a gap.
const FIX_DIRECTIVE = {
  'todo-marker': 'Never emit TODO/TBD/FIXME markers — write the finished text, or omit the section entirely.',
  'lorem-ipsum': 'Never emit lorem-ipsum filler — every sentence must be grounded in the real page content given.',
  'placeholder-bracket': 'Never emit "[Insert X here]"-style brackets — supply the real value, or leave the field out.',
  'template-braces': 'Never leave an unfilled "{{variable}}" — substitute the real value before returning.',
  'outline-heading': 'Write real body copy, never outline scaffolding like "Section 1:" or "Introduction:".',
  'instructional-filler': 'Write the actual content, never a meta-instruction describing what should be written there.',
  'llm-meta-commentary': "Write in the site's own voice — never refer to yourself as an AI or narrate your process.",
  'llm-refusal': 'Complete the draft from the evidence given; if it is genuinely insufficient, return fewer fields rather than a refusal.',
  'nav-leakage': 'Use only the page\'s main body text — never navigation, header, or footer boilerplate.',
  'author-placeholder': 'Never invent a byline. Omit author attribution entirely when no real author profile is configured.',
  'duplicate-paragraph': 'Each section must say something distinct — never repeat a paragraph across sections.',
  'schema-missing-context': 'Every JSON-LD block must include "@context": "https://schema.org".',
  'schema-missing-type': 'Every JSON-LD block must include an "@type".',
  'schema-missing-required-field': "Include every field Google's guidelines require for the @type being emitted.",
  'empty-section': 'Never return an empty or non-answer body — omit the section instead of shipping a placeholder one.',
};

// null (not a generic string) when unknown: a lesson with no real directive
// must stay advisory rather than carry invented guidance into a prompt.
export function fixDirectiveForPattern(patternId) {
  return FIX_DIRECTIVE[patternId] || null;
}

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
