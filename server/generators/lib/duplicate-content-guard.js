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

// JSON-LD fields (faq.js's schemaJsonLd, any future generator's equivalent)
// are a deterministic transform of the generator's own prose fields, never a
// second LLM authoring — faq.js's mainEntity[].acceptedAnswer.text is built
// FROM items[].answer, so it will always collide with it here. That's not an
// LLM repeating itself, it's structured markup mirroring the visible content
// on purpose (the entire point of FAQPage schema). Skipping these keys keeps
// this guard checking prose an LLM actually wrote twice, not a generator's
// own required mirror of what it wrote once (real incident, 2026-08-14: FAQ
// generation failed the Quality Gate on every attempt, permanently, for any
// page — 100% of items[].answer collided with schemaJsonLd.mainEntity[].
// acceptedAnswer.text by construction).
//
// meta-title.js's `titles` is a set of alternative <title> candidates for the
// SAME query, meant for a human to pick one from — not sequential prose an
// LLM could be caught repeating. All 3 are independently tightened to the
// same 50-60 character window by the same rewrite prompt, so they routinely
// differ only in punctuation/casing/a swapped connector (e.g. "Austin, TX"
// vs "Austin TX"), which this guard's normalization strips before comparing
// — collapsing two genuinely-alternative candidates into a false collision
// (real incident, 2026-08-25: a meta-title draft could never be approved,
// permanently, because 2 of its 3 title candidates normalized identically).
//
// open-graph.js's `twitterTitle`/`twitterDescription` deterministically
// mirror `ogTitle`/`ogDescription` verbatim (no second grounding decision,
// no LLM call at all) — same shape as the schemaJsonLd mirror above, just a
// plain string copy instead of a JSON-LD transform. Left unexempted, any
// draft with a real (non-placeholder) og:description would fail this check
// on every attempt, permanently, since the two fields are always identical
// by construction.
const NON_PROSE_KEYS = new Set([
  'schemaJsonLd', 'jsonLd', 'titles', 'twitterTitle', 'twitterDescription',
]);

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
    for (const [k, v] of Object.entries(value)) {
      if (NON_PROSE_KEYS.has(k)) continue;
      collectParagraphs(v, path ? `${path}.${k}` : k, out);
    }
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
