// Generic gate against incomplete LLM output: outline instructions,
// placeholder brackets, template artifacts, or refusal text that slipped
// through as if it were finished draft content. This is deliberately
// separate from schema.js/open-graph.js/analytics-install.js's own
// PLACEHOLDER_NOTE convention — that literal is an intentional, safe
// "needs real data" marker already enforced at publish time by
// implementers/adapters/data-array-content.js and marker-merge.js. This
// guard instead catches the LLM being lazy or broken: leaving in meta-
// instructions, "[Insert X here]"-style brackets, unfilled template
// braces, lorem ipsum, or "as an AI language model" leakage — content that
// would ship to a live page looking obviously unfinished or wrong.
//
// Walks any generator's `content` value (object/array/string, whatever
// shape that generator uses per types.js) and returns a list of issues;
// an empty list means the content is clean.

const SCAFFOLDING_PATTERNS = [
  { id: 'todo-marker', regex: /\b(TODO|TBD|FIXME)\b/ },
  { id: 'lorem-ipsum', regex: /\blorem ipsum\b/i },
  { id: 'placeholder-bracket', regex: /\[\s*(insert|add|write|include|placeholder|fill[\s-]?in|your\s)[^\]]{0,80}\]/i },
  { id: 'template-braces', regex: /\{\{[^{}]{1,80}\}\}/ },
  { id: 'outline-heading', regex: /^\s*(section|part|chapter)\s*\d+\s*[:.]/im },
  { id: 'instructional-filler', regex: /\b(write|insert|add)\s+(a|an|the)?\s*(introduction|conclusion|paragraph|section|body copy|content)\s+here\b/i },
  { id: 'llm-meta-commentary', regex: /\bas an ai (language model|assistant)\b/i },
  { id: 'llm-refusal', regex: /\bi('m| am)?\s*(unable to|cannot|can't)\s+(help|assist|generate|provide|complete)\b/i },
  // Defense-in-depth against page-content.js's extraction bug class (fixed
  // 2026-08-07: analyzePage() no longer grounds LLM prompts in raw
  // document.body, see extractMainText) — catches nav/template boilerplate
  // that made it into generated copy anyway, e.g. an LLM echoing "grounding"
  // text back verbatim instead of writing new prose about it.
  { id: 'nav-leakage', regex: /\b(skip to (main )?content|toggle navigation|all rights reserved|back to top|subscribe to our newsletter|add to cart|main menu)\b/i },
  // expand-content.js's author-byline focus falls back to instructing the
  // LLM to write "By [Author Name], [Role]" whenever a site has no real
  // configured author profile (generators/lib/author-profile.js) — that's
  // the right behavior for a human editor to fill in later, but it must
  // never silently auto-ship as real byline text, since expand-content is
  // 'safe'-tier (risk-tiers.js) and this exact focus is what
  // auto-remediation.js would otherwise publish unattended.
  { id: 'author-placeholder', regex: /\[\s*(author name|your name|role|job title)\s*\]/i },
];

function walk(value, path, issues) {
  if (typeof value === 'string') {
    for (const { id, regex } of SCAFFOLDING_PATTERNS) {
      const match = value.match(regex);
      if (match) issues.push({ path, patternId: id, snippet: match[0].slice(0, 120) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, issues));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) walk(v, path ? `${path}.${key}` : key, issues);
  }
}

// Returns [] when content is clean, otherwise a list of
// { path, patternId, snippet } describing every match found. generatorId is
// accepted (not currently used to skip anything — the last exemption,
// blog-outline, was removed 2026-08-07 once it stopped shipping outlines)
// so a future genuinely-outline-shaped generator can reintroduce a
// narrower exemption without changing every call site.
export function findScaffoldingIssues(content, _generatorId) {
  const issues = [];
  walk(content, '', issues);
  return issues;
}
