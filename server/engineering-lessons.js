import { query } from './db.js';

// Read/write for engineering_fix_lessons (migration 087) — the code-bug
// analog of fix_lessons (086)/lessons.js. Two consumers: the backfill script
// (server/scripts/backfill-engineering-lessons.js) and the query script
// (server/scripts/engineering-lessons.js) that Claude Code runs against a
// file path before touching it. No cache here (unlike lessons.js) — this is
// invoked interactively/per-script-run, not on every LLM call, so a 60s
// cache would only add staleness risk for no real benefit.

export async function getEngineeringLessons(bugCategory) {
  const { rows } = await query(
    `SELECT id, bug_category, symptom, root_cause, fix_pattern, applies_to, source_ref, created_at
     FROM engineering_fix_lessons
     WHERE active AND ($1::text IS NULL OR bug_category = $1)
     ORDER BY created_at ASC`,
    [bugCategory || null],
  );
  return rows;
}

// Every active lesson, for the file/pattern matching done by Consumer 1's
// query script (and, if wired later, Consumer 2's withEngineeringLessons).
export async function getAllEngineeringLessons() {
  const { rows } = await query(
    `SELECT id, bug_category, symptom, root_cause, fix_pattern, applies_to, source_ref, created_at
     FROM engineering_fix_lessons
     WHERE active
     ORDER BY created_at ASC`,
  );
  return rows;
}

export async function addEngineeringLesson({ bugCategory, symptom, rootCause, fixPattern, appliesTo, sourceRef = null }) {
  if (!bugCategory || !symptom || !rootCause || !fixPattern || !appliesTo) {
    throw new Error('bugCategory, symptom, rootCause, fixPattern, and appliesTo are required');
  }
  const { rows } = await query(
    `INSERT INTO engineering_fix_lessons (bug_category, symptom, root_cause, fix_pattern, applies_to, source_ref)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [bugCategory, symptom, rootCause, fixPattern, appliesTo, sourceRef],
  );
  return rows[0].id;
}

// Dedup check for the backfill script: same bug_category plus any overlap
// between the two applies_to strings (case-insensitive substring either
// direction) counts as the same lesson — merge into it rather than
// inserting a near-duplicate. Deliberately simple string comparison, not
// embeddings/vector search, so the dedup decision stays inspectable.
export function findSimilarLesson(existingLessons, { bugCategory, appliesTo }) {
  const category = bugCategory.toLowerCase();
  const pattern = appliesTo.toLowerCase();
  return existingLessons.find((l) => {
    if (l.bug_category.toLowerCase() !== category) return false;
    const existingPattern = l.applies_to.toLowerCase();
    return existingPattern.includes(pattern) || pattern.includes(existingPattern);
  }) || null;
}

// Merge a newly-extracted duplicate into an existing row: widen applies_to
// if the new pattern adds anything not already covered, keep the earlier
// source_ref (first-fixed wins), leave everything else untouched. Used by
// the backfill script's substring-based dedup pass.
export async function mergeIntoLesson(existingLesson, { appliesTo }) {
  const existingPattern = existingLesson.applies_to;
  if (existingPattern.toLowerCase().includes(appliesTo.toLowerCase())) return existingLesson.id;
  const merged = `${existingPattern}; ${appliesTo}`;
  await query(`UPDATE engineering_fix_lessons SET applies_to = $1 WHERE id = $2`, [merged, existingLesson.id]);
  return existingLesson.id;
}

// Merge a newly-extracted duplicate into an existing row using the LLM-judged
// merged wording (see findDuplicateLesson in engineering-lesson-extraction.js)
// instead of a substring widen — used by extract-branch-lesson.js's ongoing
// per-PR insert, where two independent extraction runs on the same underlying
// bug can produce differently-worded lessons that substring matching misses.
// Appends the new source_ref to the existing one (comma-separated, deduped)
// so traceability back to every contributing commit/PR is kept, not just the
// first one.
export async function mergeLessonUpdate(existingLesson, { symptom, rootCause, fixPattern, appliesTo, sourceRef }) {
  const refs = new Set((existingLesson.source_ref || '').split(',').map((r) => r.trim()).filter(Boolean));
  if (sourceRef) refs.add(sourceRef);
  await query(
    `UPDATE engineering_fix_lessons
     SET symptom = $1, root_cause = $2, fix_pattern = $3, applies_to = $4, source_ref = $5
     WHERE id = $6`,
    [symptom, rootCause, fixPattern, appliesTo, [...refs].join(', '), existingLesson.id],
  );
  return existingLesson.id;
}
