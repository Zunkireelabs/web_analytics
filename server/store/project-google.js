import { query } from '../db.js';

// A project's own Google connection (migration 200). The token itself is never read
// through here — server/auth/project-google.js is the one reader, and only to build a
// client — so nothing that lists or serialises a connection can ever carry it.

// Who connected, as the screens show it. No token, encrypted or not.
export async function getGoogleConnection(siteId) {
  const { rows } = await query(
    'SELECT google_email, scopes, connected_by, updated_at FROM project_google_connections WHERE site_id = $1', [siteId]);
  return rows[0] || null;
}

// Connecting again replaces the previous connection: one Google account per project.
export async function saveGoogleConnection({ siteId, email, refreshTokenEnc, scopes, connectedBy }) {
  await query(
    `INSERT INTO project_google_connections (site_id, google_email, refresh_token_enc, scopes, connected_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (site_id) DO UPDATE
       SET google_email = EXCLUDED.google_email, refresh_token_enc = EXCLUDED.refresh_token_enc,
           scopes = EXCLUDED.scopes, connected_by = EXCLUDED.connected_by, updated_at = now()`,
    [siteId, email ?? null, refreshTokenEnc, scopes ?? null, connectedBy ?? null]);
}

export async function deleteGoogleConnection(siteId) {
  const { rowCount } = await query('DELETE FROM project_google_connections WHERE site_id = $1', [siteId]);
  return rowCount === 1;
}
