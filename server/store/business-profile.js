import { query } from '../db.js';
import { normalizeProfile, profileState, contentHash, emptyProfile } from '../lib/business-profile.js';

// Storage for the canonical business profile (migration 258, business_profile_versions). Append-only: every change is a new version.
// Every function takes a siteId and puts it in the WHERE clause; nothing here can read or write another project's profile.
//
// While the table does not exist yet (the migration awaits review) every read returns null and every write reports
// { skipped: 'no-table' }, so the rest of the system carries on exactly as it did before the profile existed.

const UNDEFINED_TABLE = '42P01';
const isMissingTable = (err) => err?.code === UNDEFINED_TABLE || /business_profile_versions.*does not exist/i.test(String(err?.message || ''));

function requireSiteId(siteId) {
  const n = Number(siteId);
  if (!Number.isInteger(n) || n <= 0) throw new TypeError('A business profile always belongs to a project: siteId is required.');
  return n;
}

const shape = (r) => ({
  id: r.id,
  siteId: r.site_id,
  version: r.version,
  status: r.status,
  profile: normalizeProfile(r.profile),
  contentHash: r.content_hash,
  pending: Array.isArray(r.change_summary?.pending) ? r.change_summary.pending : [],
  changeSummary: r.change_summary || {},
  source: r.source,
  actor: r.actor,
  reason: r.reason,
  createdAt: r.created_at,
});

// The newest version, or null when the project has none (or the table is not there yet).
export async function getCurrentBusinessProfile(siteId, { run = query } = {}) {
  const id = requireSiteId(siteId);
  try {
    const { rows } = await run(
      `SELECT id, site_id, version, status, profile, content_hash, change_summary, source, actor, reason, created_at
         FROM business_profile_versions WHERE site_id = $1 ORDER BY version DESC LIMIT 1`, [id]);
    return rows[0] ? shape(rows[0]) : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

export async function getBusinessProfileVersion(siteId, version, { run = query } = {}) {
  const id = requireSiteId(siteId);
  try {
    const { rows } = await run(
      `SELECT id, site_id, version, status, profile, content_hash, change_summary, source, actor, reason, created_at
         FROM business_profile_versions WHERE site_id = $1 AND version = $2`, [id, Number(version)]);
    return rows[0] ? shape(rows[0]) : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

// History, newest first, without the full profile bodies (the list view only needs who/when/why/what changed).
export async function listBusinessProfileVersions(siteId, { limit = 50, run = query } = {}) {
  const id = requireSiteId(siteId);
  try {
    const { rows } = await run(
      `SELECT id, version, status, content_hash, change_summary, source, actor, reason, created_at
         FROM business_profile_versions WHERE site_id = $1 ORDER BY version DESC LIMIT $2`,
      [id, Math.min(Math.max(Number(limit) || 50, 1), 200)]);
    return rows.map((r) => ({
      id: r.id, version: r.version, status: r.status, contentHash: r.content_hash, source: r.source, actor: r.actor,
      reason: r.reason, createdAt: r.created_at,
      changed: r.change_summary?.changed || [], applied: r.change_summary?.applied || [],
      pendingCount: Array.isArray(r.change_summary?.pending) ? r.change_summary.pending.length : 0,
      usage: r.change_summary?.usage || null,
    }));
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

// Appends a version. Skips the write when nothing changed (same content and same pending findings as the latest version), so a weekly
// re-check that finds nothing new does not fill the history. The version number is computed inside the INSERT so two writers racing
// cannot produce the same number.
export async function insertBusinessProfileVersion(siteId, {
  profile, pending = [], changed = [], applied = [], usage = null, source = 'system', actor = null, reason = 'refresh',
}, { run = query } = {}) {
  const id = requireSiteId(siteId);
  const clean = normalizeProfile(profile || emptyProfile());
  const hash = contentHash(clean);
  const latest = await getCurrentBusinessProfile(id, { run });
  if (latest && latest.contentHash === hash && JSON.stringify(latest.pending) === JSON.stringify(pending)) {
    return { unchanged: true, version: latest.version };
  }
  const summary = { changed, pending, applied, ...(usage ? { usage } : {}) };
  try {
    const { rows } = await run(
      `INSERT INTO business_profile_versions (site_id, version, status, profile, content_hash, change_summary, source, actor, reason)
       SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8
         FROM business_profile_versions WHERE site_id = $1
       ON CONFLICT (site_id, version) DO NOTHING
       RETURNING id, version, status, created_at`,
      [id, profileState(clean), JSON.stringify(clean), hash, JSON.stringify(summary), source, actor == null ? null : String(actor), reason]);
    if (!rows[0]) return { skipped: 'conflict' };
    return { unchanged: false, version: rows[0].version, status: rows[0].status, createdAt: rows[0].created_at };
  } catch (err) {
    if (isMissingTable(err)) return { skipped: 'no-table' };
    throw err;
  }
}
