// Phase 6: governance of the shared (cross-project) learning.
//
// BOUNDARIES (one place, so tests and people read the same rules):
//   project   - project memory, behaviour history, drafts, pages, queries. Keyed by site_id. Never leaves the project; every
//               reader takes the site id (and project memory can additionally refuse a workspace mismatch).
//   workspace - members, permissions, shared settings. Keyed by workspace_id. Projects of one workspace do not read each
//               other's memory either; a workspace is an ownership boundary, not a data pool.
//   industry  - the ONLY shared layer. Table industry_knowledge (+ its log) has no site_id / workspace_id and holds labels from a
//               fixed catalog plus counts. A project contributes only if opted in, its industry is known with confidence, and a
//               pattern is served only when enough distinct projects agree (each project counts as its own client) (lib/industry-intelligence.js).
//
// What this module adds: human review of shared knowledge (hold back / reject / restore, always with a reviewer and a
// reason), the readable history of how knowledge changed, and a plain measure of whether past learning held up.
// It reads and writes only the shared tables, so it cannot touch tenant data.

export const REVIEW_STATES = Object.freeze(['approved', 'quarantined', 'rejected']);

// Pure.
export function validateReview({ id, state, by, reason }) {
  const problems = [];
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) problems.push('a knowledge id is required');
  if (!REVIEW_STATES.includes(state)) problems.push(`state must be one of ${REVIEW_STATES.join(', ')}`);
  if (!by || !String(by).trim()) problems.push('a reviewer is required (who is making this decision)');
  if (!reason || String(reason).trim().length < 5) problems.push('a reason of at least a few words is required');
  return problems;
}

// Applies a human review and records it. Returns the updated row. Throws on invalid input or an unknown id.
export async function reviewKnowledge({ id, state, by, reason }, { deps = {} } = {}) {
  const problems = validateReview({ id, state, by, reason });
  if (problems.length) throw new Error(`Review refused: ${problems.join('; ')}`);
  const q = deps.query || (await import('../db.js')).query;
  const { rows: cur } = await q(`SELECT * FROM industry_knowledge WHERE id = $1`, [Number(id)]);
  if (!cur[0]) throw new Error(`No shared knowledge with id ${id}`);
  const row = cur[0];
  const { rows } = await q(
    `UPDATE industry_knowledge SET review_state = $2, reviewed_by = $3, reviewed_at = now(), review_reason = $4 WHERE id = $1 RETURNING *`,
    [row.id, state, String(by).trim(), String(reason).trim()]
  );
  await q(
    `INSERT INTO industry_knowledge_log (knowledge_id, industry, sub_industry, kind, subject, event, from_status, to_status,
                                         from_polarity, to_polarity, from_confidence, to_confidence, review_state, evidence, reason, actor)
     VALUES ($1,$2,$3,$4,$5,'reviewed',$6,$6,$7,$7,$8,$8,$9,$10::jsonb,$11,$12)`,
    [row.id, row.industry, row.sub_industry, row.kind, row.subject, row.status, row.polarity, row.confidence, state,
     JSON.stringify(row.evidence || {}), String(reason).trim(), String(by).trim()]
  );
  return rows[0];
}

export async function getKnowledgeHistory({ id = null, industry = null, subject = null, limit = 50 } = {}, { deps = {} } = {}) {
  const q = deps.query || (await import('../db.js')).query;
  const { rows } = await q(
    `SELECT * FROM industry_knowledge_log
      WHERE ($1::bigint IS NULL OR knowledge_id = $1)
        AND ($2::text IS NULL OR industry = $2)
        AND ($3::text IS NULL OR subject = $3)
      ORDER BY created_at DESC, id DESC LIMIT $4`,
    [id, industry, subject, Math.min(Number(limit) || 50, 500)]
  );
  return rows;
}

// Pure. Did past learning hold up? Reads the log (what was ever validated and what happened to it) and the current rows.
//   everValidated - patterns that were validated at some point
//   heldUp        - of those, still validated now
//   reversed      - were validated, later contradicted / retired (the data changed its mind)
//   heldBack      - currently quarantined or rejected by a person
// reversalRate is null when nothing was ever validated: "no evidence yet" is not 0%.
export function summarizeLearningQuality(logRows, currentRows) {
  const key = (r) => `${r.industry}|${r.sub_industry}|${r.kind}|${r.subject}`;
  const everValidated = new Set();
  for (const e of logRows || []) if (e.to_status === 'validated' || e.from_status === 'validated') everValidated.add(key(e));
  const now = new Map((currentRows || []).map((r) => [key(r), r]));
  let heldUp = 0;
  let reversed = 0;
  for (const k of everValidated) {
    const cur = now.get(k);
    if (cur && cur.status === 'validated') heldUp += 1;
    else if (!cur || cur.status === 'contradicted' || cur.status === 'retired') reversed += 1;
  }
  const rows = currentRows || [];
  return {
    patterns: rows.filter((r) => r.kind === 'generator-outcome').length,
    validatedNow: rows.filter((r) => r.status === 'validated').length,
    everValidated: everValidated.size,
    heldUp,
    reversed,
    reversalRate: everValidated.size ? Number((reversed / everValidated.size).toFixed(2)) : null,
    contradicted: rows.filter((r) => r.status === 'contradicted').length,
    heldBack: rows.filter((r) => r.review_state === 'quarantined' || r.review_state === 'rejected').length,
    setAsideOutcomes: rows.reduce((n, r) => n + (Number(r.evidence?.confounded) || 0), 0),
  };
}

export async function getGovernanceReport({ deps = {} } = {}) {
  const q = deps.query || (await import('../db.js')).query;
  const { rows: current } = await q(`SELECT * FROM industry_knowledge ORDER BY industry, kind, subject`);
  const { rows: log } = await q(`SELECT industry, sub_industry, kind, subject, from_status, to_status FROM industry_knowledge_log`);
  const { rows: recent } = await q(`SELECT * FROM industry_knowledge_log ORDER BY created_at DESC, id DESC LIMIT 15`);
  return { current, recent, quality: summarizeLearningQuality(log, current) };
}
