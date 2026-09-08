import { query } from '../db.js';

// baseline_reports (migration 150) — one row per site, the client-facing
// "day 0" snapshot. Upsert-on-conflict rather than the strict "only if
// unset" guard sites.onboarded_at uses (setOnboardingBaseline in upsert.js),
// since this also backs the staff "Generate Now"/regenerate path for sites
// onboarded before this feature existed, or whose first attempt failed.
export async function saveBaselineReport(siteId, { kpiSnapshot, issuesSnapshot, narrativeMd }) {
  const { rows } = await query(
    `INSERT INTO baseline_reports (site_id, kpi_snapshot, issues_snapshot, narrative_md)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id) DO UPDATE SET
       generated_at = now(), kpi_snapshot = $2, issues_snapshot = $3, narrative_md = $4
     RETURNING *`,
    [siteId, JSON.stringify(kpiSnapshot), JSON.stringify(issuesSnapshot), narrativeMd]
  );
  return rows[0];
}

export async function getBaselineReport(siteId) {
  const { rows } = await query('SELECT * FROM baseline_reports WHERE site_id = $1', [siteId]);
  return rows[0] || null;
}
