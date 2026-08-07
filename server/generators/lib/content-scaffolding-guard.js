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
];

// Skip generators whose entire, intentional output shape IS an outline —
// "notes"/"section" fields there are the product, not leftover scaffolding.
const EXEMPT_GENERATOR_IDS = new Set(['blog-outline']);

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
// { path, patternId, snippet } describing every match found.
export function findScaffoldingIssues(content, generatorId) {
  if (EXEMPT_GENERATOR_IDS.has(generatorId)) return [];
  const issues = [];
  walk(content, '', issues);
  return issues;
}
