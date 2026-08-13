// Phase 4 of the Quality Gate work: turns a human's real edit to a draft
// (before approving it) into a reusable agent_fix_memory row (migration 097 —
// this used to write fix_lessons/086, consolidated in f40fa76), instead of the
// same class of correction being made by hand again on the next page this
// generator drafts. Deliberately deterministic — no LLM call guessing WHY a
// human changed something (that would be fabricating intent this module has no
// way to actually know); it just records WHAT KIND of change was made, which
// is a real, verifiable fact. Once written, server/llm.js's withAgentMemory()
// already injects it into every future call for that generatorId/site
// automatically — this module's only job is detecting the edit and describing
// it, not the "apply it next time" half, which already exists.
//
// It describes the edit rather than quoting it: agent_fix_memory is a
// cross-tenant store, so anything written here can reach another client's
// generation prompt. See describeEdit() at the bottom.

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

  const lesson = diffs.map((d) => `On "${d.path}", a human corrected the drafted text before approving — ${describeEdit(d.before, d.after)}. Prefer this kind of correction on similar content.`).join(' ');

  const fieldKeys = new Set(diffs.map((d) => normalizedFieldKey(generatorId, d.path)));
  const validationRuleId = fieldKeys.size === 1 ? `human-edit:${[...fieldKeys][0]}` : null;

  return {
    title: `Human correction learned from an approved ${generatorId} draft`,
    lesson, category: 'human-correction', validationRuleId,
  };
}

// Describes the SHAPE of a human's correction without reproducing either
// version of the text.
//
// The previous version of this function's caller quoted both the drafted and
// the corrected text verbatim (160 chars each) straight into the lesson. That
// text is real client draft content — a page's actual copy, meta description,
// or FAQ answer — and agent_fix_memory is a cross-tenant store: a row written
// with site_id NULL is retrievable by every other client's generators via
// withAgentMemory (server/llm.js). So one client's unpublished draft copy
// could be injected into another client's generation prompt. That is the leak
// this closes.
//
// What survives is what actually makes the lesson useful as a prompt hint:
// WHICH field keeps getting corrected (the path, already non-identifying) and
// WHAT KIND of correction it was. The generator learns "shorten this field and
// stop putting links in it" rather than "here is what LifeLinkNepal wrote."
// Deliberately deterministic and non-LLM, preserving this module's own stated
// rule against fabricating intent it cannot know.
function describeEdit(before, after) {
  const parts = [];

  const delta = after.length - before.length;
  const ratio = before.length ? Math.abs(delta) / before.length : 1;
  if (ratio < 0.1) parts.push('reworded it at about the same length');
  else if (delta < 0) parts.push(`shortened it by roughly ${Math.round(ratio * 100)}%`);
  else parts.push(`expanded it by roughly ${Math.round(ratio * 100)}%`);

  // Categorical facts about the edit, never the content itself. Each is the
  // kind of thing a generator can actually act on next time.
  const linkDelta = countMatches(after, /https?:\/\/|\]\(/g) - countMatches(before, /https?:\/\/|\]\(/g);
  if (linkDelta > 0) parts.push('added a link');
  else if (linkDelta < 0) parts.push('removed a link');

  const digitDelta = countMatches(after, /\d/g) - countMatches(before, /\d/g);
  if (digitDelta > 0) parts.push('introduced specific numbers');
  else if (digitDelta < 0) parts.push('removed specific numbers');

  if (/[!?]{1,}/.test(before) && !/[!?]/.test(after)) parts.push('removed exclamation/question punctuation');

  return parts.join(', ');
}

function countMatches(s, re) {
  return (s.match(re) || []).length;
}
