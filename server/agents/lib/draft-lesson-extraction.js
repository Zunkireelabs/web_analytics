// Phase 4 of the Quality Gate work: turns a human's real edit to a draft
// (before approving it) into a reusable fix_lessons row (migration 086),
// instead of the same class of correction being made by hand again on the
// next page this generator drafts. Deliberately deterministic — no LLM call
// guessing WHY a human changed something (that would be fabricating intent
// this module has no way to actually know); it just records WHAT changed,
// framed as a correction, which is a real, verifiable fact. Once written,
// server/llm.js's existing withLessons() already injects it into every
// future call for that generatorId/site automatically — this module's only
// job is detecting the edit and writing it, not the "apply it next time"
// half, which already exists.

const MAX_LESSON_DIFFS = 3; // a handful of concrete corrections is a useful prompt addition; dozens would just bloat every future call
const MIN_STRING_LEN_TO_COMPARE = 3; // skip near-empty leaf values — noise, not a real correction

function collectStrings(value, path, out) {
  if (typeof value === 'string') {
    if (value.trim().length >= MIN_STRING_LEN_TO_COMPARE) out.set(path, value.trim());
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectStrings(v, path ? `${path}.${k}` : k, out);
  }
}

// Array indices are incidental to which FIELD keeps getting corrected
// (sections[0].body today, sections[2].body next time is the same class of
// correction) — normalized out of the rule id so repeated corrections to
// the same field shape actually dedupe/accumulate in fix_lessons instead of
// each looking like a one-off. The real, un-normalized path is still kept
// in the lesson text itself for a human reading it.
function normalizedFieldKey(generatorId, path) {
  return `${generatorId}:${path.replace(/\[\d+\]/g, '[]')}`;
}

// Returns null when there's no meaningful diff (nothing to learn from), or
// { title, lesson, validationRuleId, category } ready to pass straight to
// lessons.js's addLesson() — validationRuleId is only set when every diff
// this edit touched shares one field key, so "the same correction keeps
// happening" (this function's dedup key) means exactly that, not "some
// edit happened somewhere in a multi-field draft."
export function extractEditLesson(generatorId, original, edited) {
  if (!original || !edited) return null;

  const beforeStrings = new Map();
  const afterStrings = new Map();
  collectStrings(original, '', beforeStrings);
  collectStrings(edited, '', afterStrings);

  const diffs = [];
  for (const [path, after] of afterStrings) {
    const before = beforeStrings.get(path);
    if (before !== undefined && before !== after) diffs.push({ path, before, after });
    if (diffs.length >= MAX_LESSON_DIFFS) break;
  }
  if (!diffs.length) return null;

  const lesson = diffs.map((d) => `On "${d.path}", a human corrected the drafted text from "${truncate(d.before)}" to "${truncate(d.after)}" before approving — prefer this kind of correction on similar content.`).join(' ');

  const fieldKeys = new Set(diffs.map((d) => normalizedFieldKey(generatorId, d.path)));
  const validationRuleId = fieldKeys.size === 1 ? `human-edit:${[...fieldKeys][0]}` : null;

  return {
    title: `Human correction learned from an approved ${generatorId} draft`,
    lesson, category: 'human-correction', validationRuleId,
  };
}

function truncate(s) {
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}
