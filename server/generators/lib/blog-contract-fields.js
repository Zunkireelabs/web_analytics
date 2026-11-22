// The answer-first summary (quickAnswer) and visible FAQ items some clients' builds require on every new post (e.g. Admizz's validate-content.mjs).
// The model proposes them from the post it just wrote; this module only ACCEPTS what is demonstrably grounded in that post:
//   - strings only, trimmed, within length bounds;
//   - every number or figure in an answer must already appear in the post's own sections (a fabricated "30%" or "£1,203" is dropped);
//   - no URLs or links (sources are never generated: official sources are supplied by a person);
//   - FAQ: 3 to 5 items, one question mark each, duplicates collapsed.
// Anything that fails is dropped, never repaired by guessing; a post with none simply lacks the field, and a client whose build requires it
// refuses the draft for a person to complete (implementers/frontend.js checkPostContract).

const NUMBER = /(?:[£$€]\s?)?\d[\d,]*(?:\.\d+)?(?:\s?%)?/g;
const URLISH = /https?:\/\/|www\.|\]\(/i;

const norm = (s) => String(s || '').replace(/[,\s]/g, '').toLowerCase();
export function figuresIn(text) { return (String(text || '').match(NUMBER) || []).map(norm).filter((n) => n.replace(/\D/g, '').length > 0); }

function grounded(answer, bodyFigures) {
  return figuresIn(answer).every((f) => bodyFigures.has(f));
}

export function acceptQuickAnswer(value, sections = []) {
  const t = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (t.length < 40 || t.length > 360 || URLISH.test(t)) return null;
  const bodyFigures = new Set(figuresIn(sections.map((s) => `${s.heading || ''} ${s.body || ''}`).join(' ')));
  return grounded(t, bodyFigures) ? t : null;
}

export function acceptFaqItems(value, sections = []) {
  if (!Array.isArray(value)) return [];
  const bodyFigures = new Set(figuresIn(sections.map((s) => `${s.heading || ''} ${s.body || ''}`).join(' ')));
  const seen = new Set(); const out = [];
  for (const raw of value) {
    const q = typeof raw?.question === 'string' ? raw.question.trim().replace(/\s+/g, ' ') : '';
    const a = typeof raw?.answer === 'string' ? raw.answer.trim().replace(/\s+/g, ' ') : '';
    if (q.length < 12 || q.length > 200 || !q.endsWith('?') || a.length < 40 || a.length > 600) continue;
    if (URLISH.test(q) || URLISH.test(a) || !grounded(a, bodyFigures)) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push({ question: q, answer: a });
    if (out.length === 5) break;
  }
  return out.length >= 3 ? out : []; // fewer than three is not a usable FAQ block
}
