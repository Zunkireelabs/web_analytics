import { query } from '../db.js';

export const meta = {
  id: 'gsc-url-inspection',
  label: 'GSC URL Inspection',
  category: 'google',
  description: 'Real per-page index status via Search Console\'s URL Inspection API — used by the Technical SEO agent. Shares one quota-limited OAuth credential across every site on this platform.',
};

// There's nothing to actively probe on demand — a "Test connection" click
// calling urlInspection.index.inspect() itself would burn a real unit of
// the exact shared quota this check exists to protect (same reasoning
// daily-pipeline.js already uses for why IT doesn't self-probe either). So
// this just re-reads the same outcome server/agents/technical-seo.js
// already recorded on itself after its last real run — shared across
// every site (site_id null), same convention every other integration in
// this file uses, since routes/integrations.js's on-demand "Test
// connection" route always records with site_id: null regardless of which
// site's admin clicked it.
export async function check() {
  const { rows } = await query(
    `SELECT status, auth_status, error_message, recovery_action
       FROM integration_health WHERE integration_id = $1 AND site_id IS NULL`,
    [meta.id]
  );
  const row = rows[0];
  if (!row) {
    return { ok: true, authStatus: 'unknown', errorMessage: null, recoveryAction: null };
  }
  return {
    ok: row.status === 'ok',
    authStatus: row.auth_status,
    errorMessage: row.error_message,
    recoveryAction: row.recovery_action,
  };
}
