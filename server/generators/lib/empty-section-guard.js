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

function checkPair(item, path, bodyKey, issues) {
  const body = (item[bodyKey] ?? '').toString().trim();
  if (!body) {
    issues.push({ path: `${path}.${bodyKey}`, patternId: 'empty-section', snippet: '(empty)' });
    return;
  }
  if (NON_ANSWER_RE.test(body)) {
    issues.push({ path: `${path}.${bodyKey}`, patternId: 'empty-section', snippet: body });
    return;
  }
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
  for (const [field, value] of Object.entries(content)) {
    if (!Array.isArray(value)) continue;
    value.forEach((item, i) => {
      if (!item || typeof item !== 'object') return;
      const path = `${field}[${i}]`;
      if (typeof item.body === 'string') checkPair(item, path, 'body', issues);
      if (typeof item.answer === 'string') checkPair(item, path, 'answer', issues);
    });
  }
  return issues;
}
