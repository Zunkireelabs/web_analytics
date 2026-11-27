// EDITING EXACTLY THE WORDS A PERSON SELECTED. The writer is asked to rewrite only those words (never the paragraph around them), and the result is swapped in at the same
// place, so everything else in the text stays byte for byte as it was. If the words cannot be found in the stored text (they cross a link or bold marker), the caller falls back
// to rewriting the whole part.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The span of `selected` inside `text` (whitespace-insensitive), or null. Only a single, unambiguous match counts. */
export function findSelected(text, selected) {
  const words = String(selected || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || typeof text !== 'string') return null;
  const re = new RegExp(words.map(esc).join('\\s+'), 'g');
  const hits = [...text.matchAll(re)];
  if (hits.length !== 1) return null;
  return { start: hits[0].index, end: hits[0].index + hits[0][0].length, found: hits[0][0] };
}

/** `text` with the selected words replaced by `replacement`, or null when they are not found exactly once. */
export function replaceSelected(text, selected, replacement) {
  const at = findSelected(text, selected);
  return at ? `${text.slice(0, at.start)}${replacement}${text.slice(at.end)}` : null;
}

/** The writer's job for a selection: rewrite ONLY these words, in the context of the sentence they sit in. Returns the new words. */
export async function rewriteSelectedWords({ selected, around = '', instruction, topic = '', callJson, maxTokens = 400 }) {
  const system = 'You rewrite ONLY the selected words of a sentence on a company website, exactly as the editor asks. Return just the replacement for the selected words so they fit back into the same sentence: ' +
    'do not repeat or change any words outside the selection. Keep the language and tone. Never add a statistic, number, date, name or claim that is not in the selected words or the instruction, and never add a link. ' +
    'Respond with ONLY a JSON object: {"text": "the replacement words"}';
  const user = `${topic ? `Topic: ${topic}\n` : ''}Text around the selection:\n${String(around).slice(0, 1200)}\n\nSelected words (rewrite only these):\n${selected}\n\nWhat the editor wants changed:\n${instruction}`;
  const out = await callJson(system, user, { maxTokens });
  const text = String(out?.text ?? '').trim();
  if (!text) throw Object.assign(new Error('The rewrite came back empty.'), { status: 400 });
  return text;
}
