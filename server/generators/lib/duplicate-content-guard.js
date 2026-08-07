// Flags near-identical paragraphs repeated within one generated draft — an
// LLM re-stating the same point twice (e.g. two "sections" with the same
// body, or the same answer copy-pasted under two different questions) reads
// as broken/unfinished even though no single string looks wrong in
// isolation, so content-scaffolding-guard.js's per-string pattern scan can't
// catch it. Shared by quality-gate.js alongside the other checkers.

// Below this, short strings collide too often on legitimate content (two
// headings that both happen to be "Overview", two short FAQ answers that
// are both correctly "Yes." for different questions) to be a real signal.
const MIN_PARAGRAPH_WORDS = 8;

function collectParagraphs(value, path, out) {
  if (typeof value === 'string') {
    const paras = value.split(/\n{2,}|(?<=[.?!])\s{2,}/).map((p) => p.trim()).filter(Boolean);
    const candidates = paras.length > 1 ? paras : [value.trim()];
    for (const p of candidates) {
      const words = p.split(/\s+/).filter(Boolean);
      if (words.length < MIN_PARAGRAPH_WORDS) continue;
      const normalized = p.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      if (normalized) out.push({ path, text: p, normalized });
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => collectParagraphs(v, `${path}[${i}]`, out)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectParagraphs(v, path ? `${path}.${k}` : k, out);
  }
}

// Returns [] when no paragraph repeats; otherwise one issue per repeat
// occurrence (the first occurrence of a paragraph is never itself flagged).
export function findDuplicateParagraphs(content) {
  const paragraphs = [];
  collectParagraphs(content, '', paragraphs);
  const firstSeenAt = new Map(); // normalized -> first path
  const issues = [];
  for (const p of paragraphs) {
    const firstPath = firstSeenAt.get(p.normalized);
    if (firstPath) {
      issues.push({ path: p.path, patternId: 'duplicate-paragraph', snippet: p.text.slice(0, 120), duplicateOf: firstPath });
    } else {
      firstSeenAt.set(p.normalized, p.path);
    }
  }
  return issues;
}
