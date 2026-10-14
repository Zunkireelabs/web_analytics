import { query } from '../db.js';
import { sanitizeLessonText, recordFixOutcome } from '../agent-memory.js';
import { mergeDesignContext, rankDesignKnowledge, buildDesignLesson, designIssues } from '../design-agent/lib/design-knowledge.js';
import { getPageSearchTotals } from './fix-impact.js';

// Tenant design knowledge on top of agent_fix_memory (migration 189). Every
// function takes the site id first and REFUSES without one: a design lesson
// with no tenant would be a cross-tenant wildcard, which is exactly what this
// store must never create or return.

const TRUST_AT = 3;

const toRow = (r) => ({
  id: r.id, lessonKind: r.lesson_kind, signature: r.problem_signature, symptoms: r.symptoms,
  rootCause: r.root_cause, fixStrategy: r.fix_strategy, fixPattern: r.fix_pattern,
  confidence: Number(r.confidence), occurrenceCount: r.occurrence_count, status: r.status,
  designContext: r.design_context || {},
});

/** Saves or reinforces one lesson. Returns its id, or null (never throws). */
export async function saveDesignLesson(siteId, lesson, { queryFn = query } = {}) {
  if (!siteId || !lesson?.signature) return null;
  try {
    const { rows: found } = await queryFn(
      `SELECT id, design_context FROM agent_fix_memory
        WHERE category = 'design' AND site_id = $1 AND lesson_kind = $2
          AND lower(problem_signature) = lower($3) AND status != 'deprecated'`,
      [siteId, lesson.kind, lesson.signature],
    );
    if (found.length) {
      const merged = mergeDesignContext(found[0].design_context, lesson.context);
      const { rows } = await queryFn(
        `UPDATE agent_fix_memory SET
           occurrence_count = occurrence_count + 1,
           confidence = LEAST(0.95, confidence + 0.10),
           status = CASE WHEN occurrence_count + 1 >= $3 AND status = 'candidate' THEN 'trusted' ELSE status END,
           fix_strategy = $4, fix_pattern = COALESCE($5, fix_pattern),
           design_context = $2::jsonb, updated_at = now()
         WHERE id = $1 RETURNING id`,
        [found[0].id, JSON.stringify(merged), TRUST_AT, sanitizeLessonText(lesson.fixStrategy), sanitizeLessonText(lesson.fixPattern)],
      );
      return rows[0]?.id ?? null;
    }
    const { rows } = await queryFn(
      `INSERT INTO agent_fix_memory
         (category, scope, execution_permission, site_id, generator_id, problem_signature, symptoms, root_cause,
          affected_pattern, fix_strategy, fix_pattern, source_type, source_ref, lesson_kind, design_context)
       VALUES ('design','client','requires_approval',$1,$2,$3,$4,$5,$6,$7,$8,'runtime-auto',$9,$10,$11::jsonb)
       RETURNING id`,
      [siteId, lesson.generatorId, lesson.signature, sanitizeLessonText(lesson.symptoms), sanitizeLessonText(lesson.rootCause),
        sanitizeLessonText(lesson.affectedPattern), sanitizeLessonText(lesson.fixStrategy), sanitizeLessonText(lesson.fixPattern),
        lesson.sourceRef, lesson.kind, JSON.stringify(lesson.context)],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.warn(`[design-knowledge] could not save lesson for site ${siteId}: ${err.message}`);
    return null;
  }
}

/**
 * What is known about this tenant's design that bears on the job in hand.
 * Strictly this site's rows — never a NULL-site wildcard.
 */
export async function findDesignKnowledge(siteId, ctx = {}, { queryFn = query } = {}) {
  if (!siteId) return [];
  try {
    const { rows } = await queryFn(
      `SELECT * FROM agent_fix_memory
        WHERE category = 'design' AND site_id = $1
          AND status NOT IN ('flagged_for_review','deprecated')
        ORDER BY confidence DESC, occurrence_count DESC LIMIT 60`,
      [siteId],
    );
    return rankDesignKnowledge(rows.map(toRow), ctx);
  } catch (err) {
    console.warn(`[design-knowledge] lookup failed for site ${siteId}, continuing without it: ${err.message}`);
    return [];
  }
}

const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * The page's search numbers over the 28 days before the fix — the baseline the
 * later measurement is compared against, captured NOW so the lesson carries
 * its own before-picture. null for a page with no impressions (a net-new page
 * has no baseline to record, and "none" must not read as "zero").
 */
export async function captureBaseline(siteId, pageUrl, { now = new Date(), totalsFn = getPageSearchTotals } = {}) {
  if (!siteId || !pageUrl) return null;
  try {
    const end = new Date(now); end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end); start.setUTCDate(start.getUTCDate() - 27);
    const totals = await totalsFn(siteId, pageUrl, isoDay(start), isoDay(end));
    return totals ? { ...totals, capturedAt: now.toISOString() } : null;
  } catch { return null; }
}

/** Success: a validated fix, with the page's pre-fix numbers attached. */
export async function recordDesignFix(siteId, p, deps = {}) {
  const baseline = p.baseline !== undefined ? p.baseline : await captureBaseline(siteId, p.pageUrl, deps);
  return saveDesignLesson(siteId, buildDesignLesson({ ...p, kind: 'fix', baseline }), deps);
}

/** Failure: an approach that did not hold — kept so it is not repeated. */
export function recordDesignFailure(siteId, p, deps = {}) {
  return saveDesignLesson(siteId, buildDesignLesson({ ...p, kind: 'anti-pattern' }), deps);
}

/** One lesson per design issue in a failed/fixed set, in parallel, never throwing. */
export async function recordDesignIssues(siteId, kind, issues, common, deps = {}) {
  const list = designIssues(issues);
  const record = kind === 'fix' ? recordDesignFix : recordDesignFailure;
  const ids = await Promise.all(list.map((i) => record(siteId, {
    ...common, patternId: i.patternId, detail: i.detail, correction: common.correction ?? i.correction,
  }, deps)));
  return ids.filter(Boolean);
}

/** A reused 'fix' lesson that held (or did not) — drives its confidence. */
export async function recordKnowledgeReuse(rows, outcome, { siteId, generatorId, recordFn = recordFixOutcome } = {}) {
  const fixes = (rows || []).filter((r) => r.lessonKind === 'fix');
  await Promise.all(fixes.map((r) => recordFn({ memoryRefId: r.id, outcome, siteId, generatorId })
    .catch((err) => console.warn(`[design-knowledge] reuse outcome failed: ${err.message}`))));
}

/**
 * Later, once the page's real search numbers exist: attach them to the lessons
 * that came from the draft. Recorded on the lesson (before, after, delta) so a
 * fix that helped and one that did not are distinguishable.
 */
export async function attachImpactToLessons(siteId, draftId, impact, { queryFn = query } = {}) {
  if (!siteId || draftId == null || !impact) return 0;
  try {
    const { rowCount } = await queryFn(
      `UPDATE agent_fix_memory
          SET design_context = COALESCE(design_context, '{}'::jsonb) || jsonb_build_object('impact', $3::jsonb),
              updated_at = now()
        WHERE category = 'design' AND site_id = $1 AND source_ref = $2`,
      [siteId, `draft:${draftId}`, JSON.stringify(impact)],
    );
    return rowCount || 0;
  } catch (err) {
    console.warn(`[design-knowledge] could not attach impact: ${err.message}`);
    return 0;
  }
}
