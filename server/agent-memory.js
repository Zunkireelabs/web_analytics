import { query } from './db.js';
import { sanitizeForCustomer } from './lib/errors.js';

// Single authoritative shared learning/memory store for every agent in this
// platform (migration 097) — replaces fix_lessons (content-generation
// corrections, migration 086) and engineering_fix_lessons (code-bug lessons,
// migration 087) as the ONE place "where does an agent look to learn from a
// previous fix" resolves to, across every generator, every client, and
// (eventually) the separate Python data-analyst-agent service.
//
// The runtime loop this module exists to support:
//   DETECT (agent/generator finds an issue)
//   -> RETRIEVE (findRelevantMemory, called automatically before generation)
//   -> REUSE/ADAPT or DIAGNOSE NEW (generator uses/ignores the match)
//   -> APPLY (implementer pushes a branch/PR, unchanged elsewhere)
//   -> VALIDATE (fix-verification.js's real re-check, or a PR-merge signal)
//   -> LEARN (recordFixOutcome, called automatically from the validation
//      result — never from a human, Claude Code, extract-branch-lesson.js,
//      or a PR merge as a REQUIRED step)
//
// Deliberately no LLM call anywhere in this module (unlike
// engineering-lesson-extraction.js's slower, human-reviewed extraction
// path): findRelevantMemory runs inside withAgentMemory on every single
// generator LLM call, so it has to stay cheap and fast, and this repo's
// existing convention (see engineering-lessons.js's findSimilarLesson
// comment) is to keep dedup/matching decisions inspectable rather than
// embedding-based. It also avoids a circular import — withAgentMemory is
// called FROM server/llm.js's callLLM, so this module can never import
// callLLM/callLLMForJson itself. Matching is by problem_signature (an exact,
// case-insensitive key) plus a simple keyword-overlap score against
// symptoms — deliberately generalized fields, never a literal URL/file/
// client name, so a match works across sites/generators/agents by design.

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // key -> { rows, expiresAt }
function clearCache() { cache.clear(); }

// Same threshold fix_lessons used for 'candidate' -> 'auto_rule' — a lesson
// seen this many times is trusted enough to promote from 'requires_approval'
// to 'auto' (never for category='code', which is never auto-appliable by any
// client-facing agent regardless of occurrence count — see requirement 6).
const TRUST_THRESHOLD = 3;

function stopwords(text) {
  return new Set((text || '').toLowerCase().match(/[a-z0-9]+/g) || []);
}

function keywordOverlap(a, b) {
  const setA = stopwords(a);
  const setB = stopwords(b);
  let n = 0;
  for (const w of setA) if (setB.has(w)) n++;
  return n;
}

// Retrieval — "SEARCH SHARED MEMORY" in the runtime loop above. SQL
// prefilter (category/scope/site/generator/status) is the safety wall, not
// just a performance filter: `clientFacing` (default true — every caller
// that isn't the code-lesson CLI/extraction path IS client-facing) hardcodes
// `category != 'code'` before any ranking runs, so a client-facing generator
// can never retrieve a code-level lesson no matter how textually similar its
// symptoms look. Ranking after the prefilter is deterministic (exact
// problem_signature match first, then keyword overlap on symptoms, then
// confidence/occurrence_count) — no LLM judgment call in this hot path.
export async function findRelevantMemory({
  category = null, scope = 'client', siteId = null, generatorId = null,
  problemSignature = null, symptoms = null, clientFacing = true, limit = 5,
} = {}) {
  const { rows } = await query(
    `SELECT * FROM agent_fix_memory
     WHERE status NOT IN ('flagged_for_review', 'deprecated')
       AND ($1::text IS NULL OR category = $1)
       AND (NOT $2::boolean OR category != 'code')
       AND scope IN ('global', $3)
       AND (generator_id IS NULL OR generator_id = $4)
       AND (site_id IS NULL OR site_id = $5)
     ORDER BY confidence DESC, occurrence_count DESC
     LIMIT 20`,
    [category, clientFacing, scope, generatorId, siteId],
  );

  const ranked = rows
    .map((row) => {
      const exact = problemSignature && row.problem_signature
        && row.problem_signature.toLowerCase() === problemSignature.toLowerCase();
      const overlap = symptoms ? keywordOverlap(symptoms, row.symptoms) : 0;
      return { row, relevance: exact ? 1000 : overlap };
    })
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit)
    .map(({ row, relevance }) => ({
      id: row.id,
      category: row.category,
      scope: row.scope,
      executionPermission: row.execution_permission,
      status: row.status,
      siteId: row.site_id,
      generatorId: row.generator_id,
      problemSignature: row.problem_signature,
      symptoms: row.symptoms,
      rootCause: row.root_cause,
      affectedPattern: row.affected_pattern,
      fixStrategy: row.fix_strategy,
      fixPattern: row.fix_pattern,
      confidence: Number(row.confidence),
      occurrenceCount: row.occurrence_count,
      successfulReuseCount: row.successful_reuse_count,
      failedReuseCount: row.failed_reuse_count,
      relevanceReason: relevance >= 1000 ? 'exact-pattern-match' : relevance > 0 ? 'keyword-overlap' : 'category-scope-match',
    }));
  return ranked;
}

function countTrailingFailures(history) {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].outcome === 'failure') n++; else break;
  }
  return n;
}

// Reuse-outcome write — a memory row already existed and a generator
// reused/adapted it; this records whether that reuse actually held up under
// validation. Two consecutive failed reuses (not just one — a single failure
// can be a one-off environment issue) forces status to 'flagged_for_review',
// which findRelevantMemory's prefilter excludes — this is what makes a
// failed reuse actually STOP future blind reuse, not just a logged data
// point nobody acts on.
async function recordReuseOutcome(memoryRefId, { outcome, agentId, generatorId, siteId, notes }) {
  const { rows: current } = await query(
    `SELECT reuse_history FROM agent_fix_memory WHERE id = $1`,
    [memoryRefId],
  );
  if (!current.length) return null;

  const history = Array.isArray(current[0].reuse_history) ? current[0].reuse_history : [];
  const newHistory = [...history, {
    agentId: agentId || null,
    generatorId: generatorId || null,
    siteId: siteId ?? null,
    timestamp: new Date().toISOString(),
    outcome,
    notes: notes || null,
  }];
  const flipToFlagged = outcome === 'failure' && countTrailingFailures(newHistory) >= 2;

  const { rows } = await query(
    `UPDATE agent_fix_memory SET
       reuse_history = $2::jsonb,
       successful_reuse_count = successful_reuse_count + CASE WHEN $3 THEN 1 ELSE 0 END,
       failed_reuse_count = failed_reuse_count + CASE WHEN $3 THEN 0 ELSE 1 END,
       confidence = CASE WHEN $3 THEN LEAST(0.95, confidence + 0.10) ELSE GREATEST(0.05, confidence - 0.15) END,
       status = CASE WHEN $4 THEN 'flagged_for_review' ELSE status END,
       updated_at = now()
     WHERE id = $1 RETURNING id`,
    [memoryRefId, JSON.stringify(newHistory), outcome === 'success', flipToFlagged],
  );
  clearCache();
  return rows[0]?.id ?? null;
}

// A repeat occurrence of an already-known pattern — same dedup shape
// addLesson used for fix_lessons: increments occurrence_count, nudges
// confidence up, and promotes 'candidate' -> 'trusted' (and
// 'requires_approval' -> 'auto', category='code' excepted) once
// TRUST_THRESHOLD is crossed.
async function promoteOccurrence(id) {
  const { rows } = await query(
    `UPDATE agent_fix_memory SET
       occurrence_count = occurrence_count + 1,
       confidence = LEAST(0.95, confidence + 0.10),
       status = CASE WHEN occurrence_count + 1 >= $2 AND status = 'candidate' THEN 'trusted' ELSE status END,
       execution_permission = CASE
         WHEN occurrence_count + 1 >= $2 AND category != 'code' AND execution_permission = 'requires_approval'
         THEN 'auto' ELSE execution_permission END,
       updated_at = now()
     WHERE id = $1 RETURNING id`,
    [id, TRUST_THRESHOLD],
  );
  clearCache();
  return rows[0]?.id ?? null;
}

// Write — "IF SUCCESSFUL, AUTOMATICALLY LEARN/PERSIST" / "IF FAILED, RECORD
// FAILURE" in the runtime loop above. This is the ONLY write path into
// agent_fix_memory; every caller (fix-verification.js's real re-check,
// action-center.js's PR-merge/quality-gate signals, the extraction scripts)
// goes through here so outcome bookkeeping (confidence, occurrence_count,
// reuse_history, status transitions) stays in one place.
//
//   memoryRefId given         -> this was a REUSE of an existing memory; see
//                                 recordReuseOutcome.
//   memoryRefId null, success -> a genuinely NEW validated pattern. Dedups
//                                 first on (generatorId, siteId,
//                                 validationRuleId) exact match (fast path,
//                                 same shape addLesson used), then on
//                                 (category, scope, generatorId, siteId,
//                                 problem_signature) exact match; no match ->
//                                 inserts a new 'candidate' row.
//   memoryRefId null, failure -> nothing existing to update and no new
//                                 pattern was actually validated — no-op.
// Applied to every free-text field on the INSERT path below, never on read.
//
// This table is CROSS-TENANT by design: a row written with site_id NULL is
// retrievable by every other client's generators through withAgentMemory
// (server/llm.js). That makes any client-identifying text written here a real
// cross-client leak, not a theoretical one — draft-lesson-extraction.js used
// to quote a human's verbatim draft corrections straight into `symptoms`,
// which is exactly the shape this guards against now that it describes edits
// instead.
//
// Three layers, in order of specificity:
//   1. sanitizeForCustomer (lib/errors.js) — the existing whole-string
//      redaction for provider errors, HTTP statuses and stack frames. Reused
//      rather than reimplemented so this can never drift from the leak
//      patterns the rest of the app already enforces.
//   2. URLs and email addresses -> placeholders. A URL is the single most
//      identifying thing a lesson can carry, and migration 097's own column
//      comment already requires affected_pattern to be "a generalized
//      description, never a literal URL/file/client".
//   3. Long quoted runs -> <quoted-content>. A quoted span over ~80 chars is
//      almost always reproduced client copy rather than a described pattern.
//
// Redacts rather than rejects: a lesson with its URL stripped is still a
// useful pattern, whereas dropping the write loses the learning entirely. The
// NOT NULL columns therefore always receive a non-empty string.
export function sanitizeLessonText(text) {
  if (typeof text !== 'string' || !text) return text;
  const deLeaked = sanitizeForCustomer(text, '(redacted — contained internal error detail)');
  return deLeaked
    .replace(/\bhttps?:\/\/\S+/gi, '<url>')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>')
    .replace(/"([^"]{80,})"/g, '"<quoted-content>"');
}

export async function recordFixOutcome({
  memoryRefId = null,
  category, scope = 'client', siteId = null, generatorId = null,
  problemSignature, symptoms, rootCause = null, affectedPattern, fixStrategy, fixPattern = null,
  validationRuleId = null, outcome, agentId = null, notes = null,
  sourceType = 'runtime-auto', sourceRef = null,
}) {
  if (outcome !== 'success' && outcome !== 'failure') {
    throw new Error(`Unknown fix outcome "${outcome}" — expected "success" or "failure"`);
  }

  if (memoryRefId) return recordReuseOutcome(memoryRefId, { outcome, agentId, generatorId, siteId, notes });
  if (outcome === 'failure') return null; // no existing memory to downgrade, no new pattern to learn from a bare failure

  if (!category || !problemSignature || !symptoms || !affectedPattern || !fixStrategy) {
    throw new Error('category, problemSignature, symptoms, affectedPattern, and fixStrategy are required to record a new fix');
  }

  if (validationRuleId) {
    const { rows } = await query(
      `SELECT id FROM agent_fix_memory
       WHERE validation_rule_id = $1 AND generator_id IS NOT DISTINCT FROM $2 AND site_id IS NOT DISTINCT FROM $3
         AND status != 'deprecated'`,
      [validationRuleId, generatorId, siteId],
    );
    if (rows.length) return promoteOccurrence(rows[0].id);
  }

  const { rows: dup } = await query(
    `SELECT id FROM agent_fix_memory
     WHERE category = $1 AND scope = $2 AND generator_id IS NOT DISTINCT FROM $3 AND site_id IS NOT DISTINCT FROM $4
       AND lower(problem_signature) = lower($5) AND status != 'deprecated'`,
    [category, scope, generatorId, siteId, problemSignature],
  );
  if (dup.length) return promoteOccurrence(dup[0].id);

  const executionPermission = category === 'code' ? 'informational' : 'requires_approval';
  const { rows } = await query(
    `INSERT INTO agent_fix_memory
       (category, scope, execution_permission, site_id, generator_id, problem_signature, symptoms, root_cause,
        affected_pattern, fix_strategy, fix_pattern, validation_rule_id, source_type, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    // problem_signature is deliberately NOT sanitized: it is the exact
    // retrieval key both this function's own dedup lookups above and every
    // reader match on, and it is already a generated slug
    // (`${generatorId}:${tags}`), never free prose.
    [category, scope, executionPermission, siteId, generatorId, problemSignature,
      sanitizeLessonText(symptoms), sanitizeLessonText(rootCause),
      sanitizeLessonText(affectedPattern), sanitizeLessonText(fixStrategy), sanitizeLessonText(fixPattern),
      validationRuleId, sourceType, sourceRef],
  );
  clearCache();
  return rows[0].id;
}

// Active auto-appliable memory rows for a generator — the agent_fix_memory
// analog of fix_lessons' getActiveAutoRules, used by approveAndPublishDraft
// to detect a possible override: a human editing a draft from a generator
// that already has a trusted, auto-appliable memory behind it is a real
// signal that memory may no longer hold (see recordFixOutcome/
// recordReuseOutcome above for how enough such overrides eventually flips a
// row to 'flagged_for_review').
export async function getActiveAutoMemories(generatorId, siteId) {
  const { rows } = await query(
    `SELECT id FROM agent_fix_memory
     WHERE status = 'trusted' AND execution_permission = 'auto'
       AND generator_id IS NOT DISTINCT FROM $1 AND (site_id IS NULL OR site_id = $2)`,
    [generatorId, siteId ?? null],
  );
  return rows;
}

// category='code', scope='repo' rows, shaped for server/scripts/
// engineering-lessons.js — the Claude Code pre-fix CLI (see CLAUDE.md) —
// whose field names (bug_category/applies_to/fix_pattern/symptom) predate
// this table and are kept as-is here so that script's scoring/print logic
// doesn't need to change, only its data source. This is
// informational/human-consumed only, never read by a runtime agent — code
// lessons stay structurally unreachable from findRelevantMemory's
// clientFacing wall regardless (see that function's own comment).
function toCodeLessonShape(row) {
  return {
    id: row.id,
    bug_category: row.problem_signature,
    symptom: row.symptoms,
    root_cause: row.root_cause,
    fix_pattern: row.fix_pattern || row.fix_strategy,
    applies_to: row.affected_pattern,
    source_ref: row.source_ref,
    created_at: row.created_at,
  };
}

export async function getAllCodeLessons() {
  const { rows } = await query(
    `SELECT * FROM agent_fix_memory
     WHERE category = 'code' AND scope = 'repo' AND status != 'deprecated'
     ORDER BY created_at ASC`,
  );
  return rows.map(toCodeLessonShape);
}

export async function getCodeLessons(bugCategory) {
  const { rows } = await query(
    `SELECT * FROM agent_fix_memory
     WHERE category = 'code' AND scope = 'repo' AND status != 'deprecated'
       AND ($1::text IS NULL OR problem_signature = $1)
     ORDER BY created_at ASC`,
    [bugCategory || null],
  );
  return rows.map(toCodeLessonShape);
}

// Write side for server/scripts/extract-branch-lesson.js (the ongoing,
// per-PR counterpart to the one-time engineering-lessons backfill) — an
// OPTIONAL, still human-reviewed admin path, not a required step in the
// runtime learning loop (see this module's own top comment: no agent
// requires a human, Claude Code, or this script to learn). Always
// execution_permission='informational' — a code-level lesson is never
// auto-appliable by any client-facing agent, regardless of how many times
// it recurs (see recordFixOutcome's promoteOccurrence, which explicitly
// excludes category='code' from ever reaching 'auto').
export async function addCodeLesson({ bugCategory, symptom, rootCause, fixPattern, appliesTo, sourceRef = null }) {
  if (!bugCategory || !symptom || !rootCause || !fixPattern || !appliesTo) {
    throw new Error('bugCategory, symptom, rootCause, fixPattern, and appliesTo are required');
  }
  const { rows } = await query(
    `INSERT INTO agent_fix_memory
       (category, scope, execution_permission, problem_signature, symptoms, root_cause, affected_pattern, fix_strategy, source_type, source_ref)
     VALUES ('code', 'repo', 'informational', $1, $2, $3, $4, $5, 'human-edit', $6)
     RETURNING id`,
    [bugCategory, symptom, rootCause, appliesTo, fixPattern, sourceRef],
  );
  clearCache();
  return rows[0].id;
}

// Merges a newly-extracted duplicate into an existing code-lesson row using
// findDuplicateLesson's LLM-judged merged wording — the ongoing per-PR
// insert path's counterpart to the one-time backfill's simpler substring
// widen, kept because two independent extraction runs on the same
// underlying bug can produce wording with no substring overlap (see
// engineering-lesson-extraction.js's own comment on why this exists).
// Appends the new source_ref rather than overwriting, so traceability back
// to every contributing PR is kept, not just the first one.
export async function mergeCodeLesson(existingLesson, { symptom, rootCause, fixPattern, appliesTo, sourceRef }) {
  const refs = new Set((existingLesson.source_ref || '').split(',').map((r) => r.trim()).filter(Boolean));
  if (sourceRef) refs.add(sourceRef);
  await query(
    `UPDATE agent_fix_memory
     SET symptoms = $1, root_cause = $2, fix_strategy = $3, affected_pattern = $4, source_ref = $5, updated_at = now()
     WHERE id = $6`,
    [symptom, rootCause, fixPattern, appliesTo, [...refs].join(', '), existingLesson.id],
  );
  clearCache();
  return existingLesson.id;
}

// Dedup check for the one-time git-history backfill script
// (server/scripts/backfill-engineering-lessons.js): same bug_category plus
// any overlap between the two applies_to strings (case-insensitive substring
// either direction) counts as the same lesson — merge into it rather than
// inserting a near-duplicate. Deliberately simple string comparison, not
// embeddings/LLM judgment, matching engineering-lessons.js's original
// findSimilarLesson (this backfill already makes one LLM call per commit;
// a second one per dedup check would multiply that cost for a one-time
// batch job where an occasional missed merge is a low-stakes trade-off).
export function findSimilarCodeLesson(existingLessons, { bugCategory, appliesTo }) {
  const category = bugCategory.toLowerCase();
  const pattern = appliesTo.toLowerCase();
  return existingLessons.find((l) => {
    if (l.bug_category.toLowerCase() !== category) return false;
    const existingPattern = l.applies_to.toLowerCase();
    return existingPattern.includes(pattern) || pattern.includes(existingPattern);
  }) || null;
}

// Widens an existing code lesson's affected_pattern (applies_to) to also
// cover a newly-found duplicate's pattern, if it isn't already covered —
// the backfill script's substring-based dedup merge (mergeCodeLesson above
// is the LLM-judged, source_ref-appending version extract-branch-lesson.js
// uses instead).
export async function mergeCodeLessonAppliesTo(existingLesson, { appliesTo }) {
  const existingPattern = existingLesson.applies_to;
  if (existingPattern.toLowerCase().includes(appliesTo.toLowerCase())) return existingLesson.id;
  const merged = `${existingPattern}; ${appliesTo}`;
  await query(`UPDATE agent_fix_memory SET affected_pattern = $1, updated_at = now() WHERE id = $2`, [merged, existingLesson.id]);
  clearCache();
  return existingLesson.id;
}

function cacheKey(generatorId, siteId) {
  return `${generatorId}:${siteId ?? '*'}`;
}

// Drop-in replacement for llm.js's old withLessons(system, generatorId,
// siteId) — same call shape, so callLLM's call site only changes the import.
// clientFacing is always true here (every generator is client-facing), so
// category='code' rows are structurally unreachable from this path — see
// findRelevantMemory's SQL wall. Silently no-ops back to the plain system
// prompt on any lookup failure, same defensive convention withLessons used —
// a memory-table outage must never break drafting.
//
// Two enforcement layers, not one: the SQL wall above stops a code lesson
// from ever being retrieved here at all; this function additionally only
// ever inlines the literal `fixPattern` text (the reusable template) into
// the prompt when a row's executionPermission is 'auto' — a
// 'requires_approval'/'informational' row surfaces only as an advisory
// warning (symptoms/root cause), never as content the model is told to
// reuse outright. That's the concrete difference between "safe to
// auto-apply" and "advisory-only", enforced in code, not just in prompt
// wording.
export async function withAgentMemory(system, generatorId, siteId) {
  if (!generatorId) return system;
  const key = cacheKey(generatorId, siteId);
  const hit = cache.get(key);
  let rows;
  if (hit && hit.expiresAt > Date.now()) {
    rows = hit.rows;
  } else {
    try {
      rows = await findRelevantMemory({ scope: 'client', siteId, generatorId, clientFacing: true, limit: 5 });
    } catch (err) {
      console.warn(`[agent-memory] lookup failed for "${generatorId}", continuing without it: ${err.message}`);
      return system;
    }
    cache.set(key, { rows, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  if (!rows.length) return system;

  const block = rows.map((r) => {
    if (r.executionPermission === 'auto' && r.fixPattern) {
      return `- ${r.symptoms} Fix: ${r.fixPattern}`;
    }
    return `- ${r.symptoms}${r.rootCause ? ` (${r.rootCause})` : ''} [advisory — do not repeat this]`;
  }).join('\n');
  return `${system}\n\nKnown issues from past fixes — do not repeat these:\n${block}`;
}
