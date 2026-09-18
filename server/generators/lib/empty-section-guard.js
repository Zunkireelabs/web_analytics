// Flags a generator's own "this is a distinct section/item" entries that
// come back empty or too thin to be real content — an LLM that returns
// `{heading: "Pricing", body: ""}` or `{question: "...", answer: "N/A"}`
// technically satisfies the JSON shape every generator's schema expects
// (types.js) without violating any single scaffolding pattern, so nothing
// else in the Quality Gate catches it. Deliberately narrow: only checks the
// well-known array-of-{heading,body}/{question,answer} shapes every content
// generator already uses (expand-content.js, faq.js, qa-content.js,
// blog-outline.js, landing-page.js's sections), not a generic "any short
// string is bad" rule — a short `answer: "Yes."` is often genuinely correct.

const MIN_SECTION_BODY_WORDS = 5;
// A body this short is almost certainly a non-answer, not real content —
// distinguishes "empty section" from "content generator legitimately wrote
// a terse but real 4-word FAQ answer."
const NON_ANSWER_RE = /^(n\/?a|tbd|none|unknown|not applicable|no answer|coming soon)\.?$/i;

// expand-content.js's 'author-byline' focus is the one section shape in this
// codebase that is CORRECTLY short by construction, not just often short: a
// site with no individual author configured gets author-profile.js's
// deterministic organizationByline(), "By the <Site Name> Team" — 4 words
// for "Chayceproperties", and never more than a handful for any real
// business name. Checking it against MIN_SECTION_BODY_WORDS below is a
// guaranteed, permanent failure for every such site, not a flaky one:
// regeneration calls the exact same pure function and gets the exact same
// string back every time, so the Quality Gate's own regenerate-and-retry
// loop can never succeed (confirmed live, Chayce Properties/site 8864,
// 2026-09-18 — "By the Chayceproperties Team" failing 3/3 attempts). This is
// a label, not prose, same category as design-drift.js's BODY_SLOT_PLACEHOLDER
// carve-out for internal-links' anchor text — only the length check is
// exempt; a genuinely empty or "N/A"-style byline is still a real defect.
const WORD_COUNT_EXEMPT_FOCUS = new Set(['author-byline']);

function checkPair(item, path, bodyKey, issues, { skipLengthCheck = false } = {}) {
  const body = (item[bodyKey] ?? '').toString().trim();
  if (!body) {
    issues.push({ path: `${path}.${bodyKey}`, patternId: 'empty-section', snippet: '(empty)' });
    return;
  }
  if (NON_ANSWER_RE.test(body)) {
    issues.push({ path: `${path}.${bodyKey}`, patternId: 'empty-section', snippet: body });
    return;
  }
  if (skipLengthCheck) return;
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < MIN_SECTION_BODY_WORDS) {
    issues.push({ path: `${path}.${bodyKey}`, patternId: 'empty-section', snippet: body });
  }
}

// Every array field on `content` that looks like a list of section-shaped
// objects gets checked — generic across generators rather than special-
// cased per generatorId, same reasoning as the other Quality Gate checkers.
export function findEmptySections(content) {
  const issues = [];
  if (!content || typeof content !== 'object') return issues;
  const skipLengthCheck = WORD_COUNT_EXEMPT_FOCUS.has(content.focus);
  for (const [field, value] of Object.entries(content)) {
    if (!Array.isArray(value)) continue;
    value.forEach((item, i) => {
      if (!item || typeof item !== 'object') return;
      const path = `${field}[${i}]`;
      if (typeof item.body === 'string') checkPair(item, path, 'body', issues, { skipLengthCheck });
      if (typeof item.answer === 'string') checkPair(item, path, 'answer', issues, { skipLengthCheck });
    });
  }
  return issues;
}
