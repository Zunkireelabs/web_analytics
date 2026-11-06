import { query as dbQuery } from '../db.js';

// Platform-wide settings and their change history (migration 246). Everything takes an injectable `query` so it is unit-testable.
//
// A change is written WITH its history row in ONE statement, so a setting can never change without a record of who changed it, and a
// history row can never exist for a change that did not happen.

export async function getSetting(key, { query = dbQuery } = {}) {
  const { rows } = await query('SELECT value, updated_by, updated_at FROM platform_settings WHERE key = $1', [key]);
  return rows[0] ? { value: rows[0].value, updatedBy: rows[0].updated_by, updatedAt: rows[0].updated_at } : null;
}

/** Writes the setting and its history row atomically. Returns the history row. `value` is any JSON value (a string for modes). */
export async function setSetting(key, value, { by = null, email = null, query = dbQuery } = {}) {
  const json = JSON.stringify(value);
  const { rows } = await query(
    `WITH old AS (SELECT value FROM platform_settings WHERE key = $1),
          up AS (INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
                 RETURNING key)
     INSERT INTO platform_setting_changes (key, from_value, to_value, changed_by, changed_by_email)
     SELECT $1, (SELECT value FROM old), $2::jsonb, $3, $4 FROM up
     RETURNING id, key, from_value, to_value, changed_by, changed_by_email, changed_at`, [key, json, by, email]);
  return rows[0];
}

/** A change whose value lives somewhere else (e.g. sites.auto_remediation_enabled): history only. */
export async function recordChange(key, from, to, { by = null, email = null, query = dbQuery } = {}) {
  const { rows } = await query(
    `INSERT INTO platform_setting_changes (key, from_value, to_value, changed_by, changed_by_email)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, $5) RETURNING id, key, from_value, to_value, changed_by, changed_by_email, changed_at`,
    [key, from === undefined ? null : JSON.stringify(from), JSON.stringify(to), by, email]);
  return rows[0];
}

export async function listChanges(key, { limit = 10, query = dbQuery } = {}) {
  const { rows } = await query(
    `SELECT from_value, to_value, changed_by_email, changed_at FROM platform_setting_changes WHERE key = $1 ORDER BY changed_at DESC, id DESC LIMIT $2`, [key, limit]);
  return rows.map((r) => ({ at: r.changed_at, by: r.changed_by_email || null, from: r.from_value, to: r.to_value }));
}

/** The latest change per key, for many keys at once (one query for a whole list). Map key -> { at, by }. */
export async function latestChanges(keys, { query = dbQuery } = {}) {
  if (!keys.length) return new Map();
  const { rows } = await query(
    `SELECT DISTINCT ON (key) key, changed_by_email, changed_at FROM platform_setting_changes WHERE key = ANY($1) ORDER BY key, changed_at DESC, id DESC`, [keys]);
  return new Map(rows.map((r) => [r.key, { at: r.changed_at, by: r.changed_by_email || null }]));
}

/** Bookkeeping that is not a person's decision (e.g. the record of a failed plan): stored, but no history row. */
export async function putSettingQuiet(key, value, { query = dbQuery } = {}) {
  await query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, NULL, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
}
