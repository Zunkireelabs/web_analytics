import { query as dbQuery, updateSiteAutoRemediation } from '../db.js';
import { AUTONOMOUS_DRAFT_SOURCES } from './autonomous-quota.js';
import { latestChanges, recordChange } from './platform-settings.js';

// The per-project "auto-fixes" switch as the Platform page shows and changes it.
//
// THE VALUE IS NOT STORED HERE. It is sites.auto_remediation_enabled, the same column the staff Controls dialog
// (POST /internal/clients/:id/auto-remediation) writes through the same db.js updateSiteAutoRemediation, and the same validation
// (validateAutoRemediationRequest) decides whether it may be turned on, so the two can never disagree. What this module adds is the
// record of WHO changed it and WHEN (platform_setting_changes, key 'site:<id>:autonomy') and the counts the page shows next to it.
//
// The agent never merges anything. "Auto-fixes on" only means safe fixes are opened as pull requests by themselves; a person merges.

export const autonomyKey = (siteId) => `site:${siteId}:autonomy`;

export class AutonomyError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export const NEEDS_GITHUB_REASON = 'Connect GitHub first. Without a repository there is nowhere to open a pull request.';

/**
 * Pure. The autonomy object of the contract. `change` = { at, by } of the last recorded change (or null: never changed from here);
 * `drafts` = { opened, merged, waiting } counts or null when not derivable. Nothing is invented: an unknown count is null.
 */
export function autonomyView(site, { change = null, drafts = null } = {}) {
  const canEnable = Boolean(site.repo_owner && site.repo_name);
  return {
    enabled: Boolean(site.auto_remediation_enabled),
    canEnable,
    blockedReason: canEnable ? null : NEEDS_GITHUB_REASON,
    changedAt: change?.at ? new Date(change.at).toISOString() : null,
    changedBy: change?.by || null,
    last7Days: {
      opened: drafts ? drafts.opened : 0,
      merged: drafts ? drafts.merged : null,
      waiting: drafts ? drafts.waiting : null,
    },
  };
}

/**
 * Fixes opened as pull requests by the autonomous lanes in the last 7 days, per project (one query for many projects).
 * opened = a PR exists; merged / waiting come from pr_state, which GitHub-status checks keep current ('merged' / 'open').
 * created_at is the nearest date the table has to "when it was opened". Null when the columns are not there yet.
 */
export async function autonomyDraftCounts(siteIds, { query = dbQuery } = {}) {
  if (!siteIds.length) return new Map();
  try {
    const { rows } = await query(
      `SELECT site_id,
              count(*) FILTER (WHERE pr_url IS NOT NULL)::int AS opened,
              count(*) FILTER (WHERE pr_url IS NOT NULL AND pr_state = 'merged')::int AS merged,
              count(*) FILTER (WHERE pr_url IS NOT NULL AND pr_state = 'open')::int AS waiting
         FROM drafts WHERE site_id = ANY($1) AND source = ANY($2) AND created_at > now() - interval '7 days' GROUP BY site_id`,
      [siteIds, AUTONOMOUS_DRAFT_SOURCES]);
    // A project with no rows genuinely had none: zero is a fact there, not a guess.
    return new Map(siteIds.map((id) => [id, rows.find((r) => r.site_id === id) || { opened: 0, merged: 0, waiting: 0 }]));
  } catch (err) {
    if (['42P01', '42703'].includes(err.code)) return new Map();
    throw err;
  }
}

/** Last recorded change per project: Map siteId -> { at, by }. Empty when the table is not there yet. */
export async function autonomyChanges(siteIds, { query = dbQuery } = {}) {
  try {
    const m = await latestChanges(siteIds.map(autonomyKey), { query });
    return new Map(siteIds.map((id) => [id, m.get(autonomyKey(id)) || null]));
  } catch (err) {
    if (['42P01', '42703'].includes(err.code)) return new Map();
    throw err;
  }
}

export async function loadAutonomy(siteId, { query = dbQuery, site = null } = {}) {
  const row = site || (await query('SELECT * FROM sites WHERE id = $1', [siteId])).rows[0];
  if (!row) return null;
  const [changes, counts] = await Promise.all([autonomyChanges([siteId], { query }), autonomyDraftCounts([siteId], { query })]);
  return autonomyView(row, { change: changes.get(siteId) || null, drafts: counts.get(siteId) || null });
}

/**
 * Turns a project's auto-fixes on or off. Enabling needs a connected repository (validateAutoRemediationRequest, the Controls
 * dialog's own rule); disabling is always allowed. Returns { site, changed, from, to }. Throws AutonomyError.
 * `validate` and `update` are injectable for tests; by default they are the real ones.
 */
export async function setAutonomy(siteId, enabled, { by = null, email = null, query = dbQuery, update = updateSiteAutoRemediation, validate = null } = {}) {
  if (typeof enabled !== 'boolean') throw new AutonomyError('BAD_REQUEST', 'enabled must be true or false.', 400);
  const { rows } = await query('SELECT * FROM sites WHERE id = $1', [siteId]);
  const site = rows[0];
  if (!site || site.status === 'soft_deleted') throw new AutonomyError('NOT_FOUND', 'Not found.', 404);
  const dailyLimit = site.auto_remediation_daily_limit;
  const check = validate || (await import('../routes/clients.js')).validateAutoRemediationRequest;
  const invalid = check({ enabled, dailyLimit, site });
  if (invalid) throw new AutonomyError(enabled && !(site.repo_owner && site.repo_name) ? 'NEEDS_GITHUB' : 'BAD_REQUEST', invalid, 400);
  const from = Boolean(site.auto_remediation_enabled);
  if (from === enabled) return { site, changed: false, from, to: enabled, dailyLimit };
  const updated = await update({ siteId, enabled, dailyLimit });
  await recordChange(autonomyKey(siteId), from, enabled, { by, email, query });
  return { site: updated, changed: true, from, to: enabled, dailyLimit };
}

