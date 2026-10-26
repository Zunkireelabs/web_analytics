import { randomBytes } from 'node:crypto';
import { query } from '../db.js';

// free_audit_reports / free_audit_leads (migration 193). Reports are reachable
// only by their unguessable id and expire after REPORT_TTL_DAYS; leads are kept.

const REPORT_TTL_DAYS = 30;
export const ID_RE = /^[a-f0-9]{32}$/;

export async function saveReport(report) {
  const id = randomBytes(16).toString('hex');
  await query('INSERT INTO free_audit_reports (id, site_url, report) VALUES ($1, $2, $3)', [id, report.finalUrl, JSON.stringify(report)]);
  // Cheap housekeeping on write, so no separate job is needed.
  query(`DELETE FROM free_audit_reports WHERE created_at < now() - ($1 || ' days')::interval`, [String(REPORT_TTL_DAYS)]).catch(() => {});
  return id;
}

export async function getReport(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const { rows } = await query(
    `SELECT report FROM free_audit_reports WHERE id = $1 AND created_at > now() - ($2 || ' days')::interval`,
    [id, String(REPORT_TTL_DAYS)]
  );
  return rows[0]?.report ?? null;
}

export async function addLead({ email, siteUrl, reportId, scores }) {
  await query('INSERT INTO free_audit_leads (email, site_url, report_id, scores) VALUES ($1, $2, $3, $4)', [email, siteUrl, reportId, scores ? JSON.stringify(scores) : null]);
}
