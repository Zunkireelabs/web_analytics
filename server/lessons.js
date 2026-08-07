import { query } from './db.js';

// Read side of fix_lessons (see migration 086, structured in 093) — every
// LLM-backed generator call goes through callLLM/callLLMForJson (llm.js),
// which calls getLessons() itself when passed a generatorId, so this
// module's only job is the lookup + a short cache (lessons change rarely; a
// DB round trip on every single generator call would be pure overhead).
const CACHE_TTL_MS = 60_000;
const cache = new Map(); // key -> { rows, expiresAt }

// Recurring enough to trust as a real, reusable rule rather than a one-off —
// crossing this promotes a lesson from 'candidate' to 'auto_rule' status
// (still injected into prompts either way; status is a signal for staff
// review/reporting, not a gate on whether withLessons() applies it).
const AUTO_RULE_THRESHOLD = 3;
// A rule humans keep overriding more often than they confirm it is
// probably wrong, not just under-adopted — demoted to 'flagged_for_review'
// so it stops being presented anywhere as a trusted rule until a human
// looks at it, without deleting the history that got it there.
const OVERRIDE_REVIEW_RATIO = 0.5;

function cacheKey(generatorId, siteId) {
  return `${generatorId || '*'}:${siteId ?? '*'}`;
}

export async function getLessons(generatorId, siteId) {
  const key = cacheKey(generatorId, siteId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.rows;

  // status != 'flagged_for_review' is what makes the override signal
  // actually DO something instead of just being visible in a report: once
  // humans have overridden a rule often enough (lessons.js's
  // recordLessonOutcome), it stops being injected into future prompts here
  // — "flag it for review instead of continuing to apply it unchanged," not
  // silently kept in force forever.
  const { rows } = await query(
    `SELECT title, lesson FROM fix_lessons
     WHERE active AND status != 'flagged_for_review'
       AND (generator_id IS NULL OR generator_id = $1)
       AND (site_id IS NULL OR site_id = $2)
     ORDER BY created_at ASC`,
    [generatorId || null, siteId ?? null],
  );
  cache.set(key, { rows, expiresAt: Date.now() + CACHE_TTL_MS });
  return rows;
}

// Write side — called by an admin/agent recording a real fix (see
// server/scripts/add-fix-lesson.js), by fix-verification.js when a
// previously-applied fix is found to have regressed (source: 'regression'),
// by generateDraft's self-correction path (source: 'auto-fix-success'), and
// by approveAndPublishDraft's human-edit diff (source: 'human-edit') — see
// server/agents/lib/draft-lesson-extraction.js.
//
// Deduplicates on (generator_id, site_id, validation_rule_id) whenever a
// validationRuleId is given: a repeat occurrence of the SAME class of issue
// increments occurrence_count and nudges confidence up instead of piling up
// duplicate rows — this is what turns "the same issue keeps appearing" into
// a measurable, queryable fact, and what a 'candidate' rule needs to earn
// 'auto_rule' status (see recordLessonOutcome below for the complementary
// approval-time confirmation path).
export async function addLesson({
  generatorId = null, siteId = null, title, lesson, source = 'manual',
  category = null, rootCause = null, confidence = 0.5, validationRuleId = null, affectedGenerators = null,
}) {
  if (!title || !lesson) throw new Error('title and lesson are required');

  if (validationRuleId) {
    const { rows } = await query(
      `SELECT id, occurrence_count FROM fix_lessons
       WHERE validation_rule_id = $1 AND generator_id IS NOT DISTINCT FROM $2 AND site_id IS NOT DISTINCT FROM $3 AND active`,
      [validationRuleId, generatorId, siteId],
    );
    if (rows.length) {
      const id = await recordLessonOutcome(rows[0].id, 'confirmed');
      cache.clear();
      return id;
    }
  }

  const { rows } = await query(
    `INSERT INTO fix_lessons (generator_id, site_id, title, lesson, source, category, root_cause, confidence, validation_rule_id, affected_generators)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [generatorId, siteId, title, lesson, source, category, rootCause, confidence, validationRuleId, affectedGenerators || (generatorId ? [generatorId] : [])],
  );
  cache.clear();
  return rows[0].id;
}

// The complementary confirm/override path — called when a REAL OUTCOME is
// observed for a lesson that already exists, not a fresh occurrence of the
// underlying issue: a draft whose generation needed this lesson's fix
// reached actual approval (outcome: 'confirmed'), or a human's edit undid
// what an active auto_rule-status lesson would have enforced (outcome:
// 'overridden'). Both are best-effort, non-blocking signals — never throws
// on an unknown lessonId, since a caller racing a lesson's deactivation
// must never fail a real approval over bookkeeping.
export async function recordLessonOutcome(lessonId, outcome) {
  if (outcome === 'confirmed') {
    const { rows } = await query(
      `UPDATE fix_lessons SET
         occurrence_count = occurrence_count + 1,
         confidence = LEAST(0.95, confidence + 0.10),
         status = CASE WHEN occurrence_count + 1 >= $2 AND status = 'candidate' THEN 'auto_rule' ELSE status END,
         updated_at = now()
       WHERE id = $1 RETURNING id`,
      [lessonId, AUTO_RULE_THRESHOLD],
    );
    cache.clear();
    return rows[0]?.id ?? null;
  }
  if (outcome === 'overridden') {
    const { rows } = await query(
      `UPDATE fix_lessons SET
         override_count = override_count + 1,
         confidence = GREATEST(0.05, confidence - 0.15),
         status = CASE WHEN (override_count + 1) >= GREATEST(1, occurrence_count) * $2 THEN 'flagged_for_review' ELSE status END,
         updated_at = now()
       WHERE id = $1 RETURNING id`,
      [lessonId, OVERRIDE_REVIEW_RATIO],
    );
    cache.clear();
    return rows[0]?.id ?? null;
  }
  throw new Error(`Unknown lesson outcome "${outcome}" — expected "confirmed" or "overridden"`);
}

// Active auto_rule-status lessons for a generator — used by
// approveAndPublishDraft to detect a possible override (a human editing a
// draft from a generator that already has a trusted, repeatedly-confirmed
// rule behind it is a real signal the rule may no longer hold, worth
// tracking even though this app can't semantically prove the edit and the
// rule are about the same specific correction).
export async function getActiveAutoRules(generatorId, siteId) {
  const { rows } = await query(
    `SELECT id, validation_rule_id FROM fix_lessons
     WHERE active AND status = 'auto_rule' AND generator_id IS NOT DISTINCT FROM $1 AND (site_id IS NULL OR site_id = $2)`,
    [generatorId, siteId ?? null],
  );
  return rows;
}
