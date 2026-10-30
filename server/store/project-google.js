import { query } from '../db.js';

// A project's own Google connection (migration 200). The token itself is never read
// through here — server/auth/project-google.js is the one reader, and only to build a
// client — so nothing that lists or serialises a connection can ever carry it.

// Who connected, as the screens show it. No token, encrypted or not.
export async function getGoogleConnection(siteId) {
  const { rows } = await query(
    'SELECT google_email, scopes, connected_by, updated_at, status, status_error, status_at FROM project_google_connections WHERE site_id = $1', [siteId]);
  return rows[0] || null;
}

// Connecting again replaces the previous connection: one Google account per project.
export async function saveGoogleConnection({ siteId, email, refreshTokenEnc, scopes, connectedBy }) {
  await query(
    `INSERT INTO project_google_connections (site_id, google_email, refresh_token_enc, scopes, connected_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (site_id) DO UPDATE
       SET google_email = EXCLUDED.google_email, refresh_token_enc = EXCLUDED.refresh_token_enc,
           scopes = EXCLUDED.scopes, connected_by = EXCLUDED.connected_by, updated_at = now(),
           status = 'ok', status_error = NULL, status_at = NULL`,
    [siteId, email ?? null, refreshTokenEnc, scopes ?? null, connectedBy ?? null]);
}

export async function deleteGoogleConnection(siteId) {
  const { rowCount } = await query('DELETE FROM project_google_connections WHERE site_id = $1', [siteId]);
  return rowCount === 1;
}

// Records that this project's connection can no longer be used, so the screens can say
// so and nothing reads with it (or with anyone else's credentials) until it is redone.
// Only touches an existing, still-'ok' row: a repeat failure is not a new event.
export async function markGoogleConnectionStatus(siteId, status, error, { version = null } = {}) {
  // `version` is the connection's updated_at when the failing client was built. A client cached on another
  // instance from BEFORE a reconnect must not mark the new, valid connection dead, so the update only
  // applies to the same version.
  await query(
    `UPDATE project_google_connections SET status = $2, status_error = $3, status_at = now()
      WHERE site_id = $1 AND status <> $2 AND ($4::timestamptz IS NULL OR updated_at = $4::timestamptz)`,
    [siteId, status, String(error || '').slice(0, 300), version]);
}

// The Search Console / Analytics properties a project had chosen. When the Google account behind them changes
// or is disconnected, the old choice is not known to be readable by the new one, so it is cleared and the
// person chooses again. Only the two property columns: the connection row, the project and its other
// settings are untouched.
export async function clearSiteGoogleProperties(siteId) {
  await query('UPDATE sites SET gsc_property = NULL, ga4_property_id = NULL WHERE id = $1', [siteId]);
}
