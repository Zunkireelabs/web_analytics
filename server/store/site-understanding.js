import { query } from '../db.js';

// Persistence for discovery findings (migration 112). The rule this module
// enforces above all: a human decision is never overwritten by a later
// automated run (§12). Re-running discovery on a repo whose product template
// someone already chose must not re-ask the same question.

// Upsert keyed on (site, category, subject). The ON CONFLICT clause
// deliberately does NOT touch rows a human has settled: `confirmed` and
// `rejected` keep their finding, status and attribution, so re-discovery
// refreshes evidence for everything else without undoing a decision.
export async function recordFinding(siteId, {
  category, subject, finding = {}, evidence = [], confidence = 0, risk = 'medium', status = 'discovered',
}) {
  const { rows } = await query(
    `INSERT INTO site_understanding (site_id, category, subject, finding, evidence, confidence, risk, status)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
     ON CONFLICT (site_id, category, subject) DO UPDATE SET
       finding    = CASE WHEN site_understanding.status IN ('confirmed','rejected')
                         THEN site_understanding.finding ELSE EXCLUDED.finding END,
       evidence   = EXCLUDED.evidence,
       confidence = CASE WHEN site_understanding.status IN ('confirmed','rejected')
                         THEN site_understanding.confidence ELSE EXCLUDED.confidence END,
       risk       = CASE WHEN site_understanding.status IN ('confirmed','rejected')
                         THEN site_understanding.risk ELSE EXCLUDED.risk END,
       status     = CASE WHEN site_understanding.status IN ('confirmed','rejected')
                         THEN site_understanding.status ELSE EXCLUDED.status END,
       updated_at = now()
     RETURNING *`,
    [siteId, category, subject, JSON.stringify(finding), JSON.stringify(evidence), confidence, risk, status]
  );
  return rows[0];
}

export async function listFindings(siteId, { category = null, status = null } = {}) {
  const { rows } = await query(
    `SELECT * FROM site_understanding
     WHERE site_id = $1
       AND ($2::text IS NULL OR category = $2)
       AND ($3::text IS NULL OR status = $3)
     ORDER BY category, confidence DESC, subject`,
    [siteId, category, status]
  );
  return rows;
}

// Everything a human still has to decide — the queue a future Assistant
// (a LATER phase, deliberately not built here) would read to ask "what do
// you need from me?".
export async function listUnresolved(siteId) {
  return listFindings(siteId, { status: 'needs_confirmation' });
}

// A human's answer. Recorded as 'confirmed'/'rejected', which recordFinding
// above then refuses to overwrite — that pairing is what makes the knowledge
// stick across runs rather than being re-derived and re-asked.
export async function confirmFinding(id, { userId, accepted = true, chosen = null }) {
  const { rows } = await query(
    `UPDATE site_understanding
     SET status = $2, confirmed_by = $3, confirmed_at = now(), updated_at = now(),
         finding = CASE WHEN $4::jsonb IS NULL THEN finding ELSE finding || $4::jsonb END
     WHERE id = $1
     RETURNING *`,
    [id, accepted ? 'confirmed' : 'rejected', userId || null, chosen ? JSON.stringify({ chosen }) : null]
  );
  return rows[0] || null;
}

// Per-category readiness (§14): one unresolved item leaves its own category
// needing confirmation while every other category stays usable. Onboarding is
// never all-or-nothing.
export async function summarize(siteId) {
  const { rows } = await query(
    `SELECT category,
            count(*)                                                   AS total,
            count(*) FILTER (WHERE status = 'needs_confirmation')       AS unresolved,
            count(*) FILTER (WHERE status IN ('auto_configured','confirmed','validated')) AS ready,
            round(avg(confidence), 2)                                   AS avg_confidence
     FROM site_understanding WHERE site_id = $1 GROUP BY category ORDER BY category`,
    [siteId]
  );
  return rows.map((r) => ({
    category: r.category,
    total: Number(r.total),
    unresolved: Number(r.unresolved),
    ready: Number(r.ready),
    avgConfidence: r.avg_confidence == null ? null : Number(r.avg_confidence),
    state: Number(r.unresolved) > 0 ? 'NEEDS_CONFIRMATION' : 'READY',
  }));
}
