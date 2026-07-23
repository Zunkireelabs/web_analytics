import { query } from '../db.js';

// Full Site Audit persistence (migration 043). audit_runs is one row per
// audit invocation, checkpointed incrementally (pages_discovered/audited)
// rather than written once at the end, so a long-running audit's progress
// is visible mid-run and partial results survive a crash. audit_page_findings
// is one row per finding — deliberately not a JSONB blob per page, see the
// migration's own comment for why.

export async function createAuditRun({ siteId, mode, triggeredBy }) {
  const { rows } = await query(
    `INSERT INTO audit_runs (site_id, mode, triggered_by, status)
     VALUES ($1, $2, $3, 'running')
     RETURNING id, site_id, mode, triggered_by, status, started_at`,
    [siteId, mode, triggeredBy]
  );
  return rows[0];
}

export async function updateAuditRunProgress(auditRunId, { pagesDiscovered, pagesAudited } = {}) {
  const sets = [];
  const values = [];
  if (pagesDiscovered != null) { values.push(pagesDiscovered); sets.push(`pages_discovered = $${values.length}`); }
  if (pagesAudited != null) { values.push(pagesAudited); sets.push(`pages_audited = $${values.length}`); }
  if (!sets.length) return;
  values.push(auditRunId);
  await query(`UPDATE audit_runs SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
}

export async function completeAuditRun(auditRunId, { status, agentIdsRun, healthScore, errorMessage } = {}) {
  await query(
    `UPDATE audit_runs
        SET status = $2, finished_at = now(),
            agent_ids_run = COALESCE($3, agent_ids_run),
            health_score = $4, error_message = $5
      WHERE id = $1`,
    [auditRunId, status, agentIdsRun || null, healthScore ?? null, errorMessage ?? null]
  );
}

export async function getAuditRun(auditRunId) {
  const { rows } = await query('SELECT * FROM audit_runs WHERE id = $1', [auditRunId]);
  return rows[0] || null;
}

export async function listAuditRuns(siteId, limit = 20) {
  const { rows } = await query(
    'SELECT * FROM audit_runs WHERE site_id = $1 ORDER BY started_at DESC LIMIT $2',
    [siteId, limit]
  );
  return rows;
}

// Most recent run of a given mode, regardless of status — feeds the
// Milestones "Where You Stand Today" section, which needs to render running/
// failed states honestly (not just the last completed run) rather than
// silently showing stale or no data while a fresh audit is in progress.
export async function getLatestAuditRun(siteId, { mode = 'full' } = {}) {
  const { rows } = await query(
    'SELECT * FROM audit_runs WHERE site_id = $1 AND mode = $2 ORDER BY started_at DESC LIMIT 1',
    [siteId, mode]
  );
  return rows[0] || null;
}

// A run stuck in 'running' with no finished_at usually means the process
// that owned it died/restarted mid-audit (runFullSiteAudit's own try/catch
// already marks a real in-process failure as 'failed' — this only catches
// the case where the process itself never got to run that catch at all).
// Called once at server startup (server/index.js) so a stale run left over
// from a previous deploy/crash doesn't sit "running" forever — confirmed
// live: a run has been stuck 'running' for over 22 hours, which also keeps
// SiteAudit.jsx polling it indefinitely.
const STALE_RUNNING_HOURS = 2;
export async function reapStaleAuditRuns() {
  const { rows } = await query(
    `UPDATE audit_runs SET status = 'failed', finished_at = now(),
       error_message = 'Audit did not complete (process restarted or timed out).'
     WHERE status = 'running' AND started_at < now() - interval '${STALE_RUNNING_HOURS} hours'
     RETURNING id, site_id`
  );
  return rows;
}

// Extracts the one real page a finding is "about," when it has one — most
// findings carry evidence.page; a handful of site-wide findings (duplicate-
// title groups, broken-link/redirect-chain crawls) carry evidence.pages or
// evidence.sourcePages instead. NULL (not a guessed page) when neither exists.
function pageForFinding(f) {
  return f.evidence?.page ?? f.evidence?.pages?.[0] ?? f.evidence?.sourcePages?.[0] ?? null;
}

// Multi-row INSERT, chunked defensively (same UPSERT_CHUNK_SIZE-style
// pattern as store/page-inventory.js) rather than one INSERT per finding —
// a large audit can produce thousands of rows, and per-plan performance
// guidance this must be batched.
const INSERT_CHUNK_SIZE = 200;
const COLUMNS_PER_ROW = 10;
export async function saveAuditPageFindingsBatch(auditRunId, siteId, agentId, findings) {
  for (let i = 0; i < findings.length; i += INSERT_CHUNK_SIZE) {
    const chunk = findings.slice(i, i + INSERT_CHUNK_SIZE);
    const values = [];
    const rowPlaceholders = chunk.map((f, idx) => {
      const rowValues = [
        auditRunId, siteId, agentId, pageForFinding(f), f.id, f.priority,
        f.evidence != null ? JSON.stringify(f.evidence) : null,
        f.whyItMatters ?? null,
        f.recommendedAction != null ? JSON.stringify(f.recommendedAction) : null,
        f.expectedImpact != null ? JSON.stringify(f.expectedImpact) : null,
      ];
      values.push(...rowValues);
      const base = idx * COLUMNS_PER_ROW;
      return `(${rowValues.map((_, j) => `$${base + j + 1}`).join(', ')})`;
    });
    await query(
      `INSERT INTO audit_page_findings
         (audit_run_id, site_id, agent_id, page, finding_id, priority, evidence, why_it_matters, recommended_action, expected_impact)
       VALUES ${rowPlaceholders.join(', ')}`,
      values
    );
  }
}

// A full-site audit runs one agent once per ~20-page chunk (bulk-audit.js);
// an aggregated-systemic finding (findings.js's aggregateSystemicFinding)
// comes back from every chunk that has at least one failing page, each
// time with only that chunk's own affectedCount/checkedCount. The first
// occurrence is INSERTed by saveAuditPageFindingsBatch; every later
// occurrence merges into that same row instead of creating a duplicate —
// this is the write side of that merge.
export async function updateAuditPageFinding(auditRunId, findingId, { priority, evidence, whyItMatters, recommendedAction, expectedImpact } = {}) {
  await query(
    `UPDATE audit_page_findings
        SET priority = $3, evidence = $4, why_it_matters = $5, recommended_action = $6, expected_impact = $7
      WHERE audit_run_id = $1 AND finding_id = $2`,
    [
      auditRunId, findingId, priority,
      evidence != null ? JSON.stringify(evidence) : null,
      whyItMatters ?? null,
      recommendedAction != null ? JSON.stringify(recommendedAction) : null,
      expectedImpact != null ? JSON.stringify(expectedImpact) : null,
    ]
  );
}

export async function getAuditPageFindings(auditRunId, { limit = 500 } = {}) {
  const { rows } = await query(
    'SELECT * FROM audit_page_findings WHERE audit_run_id = $1 ORDER BY priority, page LIMIT $2',
    [auditRunId, limit]
  );
  return rows;
}
