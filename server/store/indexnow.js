import { query } from '../db.js';
import { generateIndexNowKey } from '../lib/indexnow.js';

// The per-project IndexNow key (migration 266). Minted once and then never changed, because the key file already published at the site's
// root is named after it.

/** The project's key, minting and saving one if it has none. Safe when two callers race: the first write wins and both get that key. */
export async function ensureIndexNowKey(siteId) {
  const { rows: [existing] } = await query('SELECT indexnow_key FROM sites WHERE id = $1', [siteId]);
  if (!existing) return null;
  if (existing.indexnow_key) return existing.indexnow_key;
  const { rows } = await query('UPDATE sites SET indexnow_key = $2 WHERE id = $1 AND indexnow_key IS NULL RETURNING indexnow_key', [siteId, generateIndexNowKey()]);
  if (rows[0]) return rows[0].indexnow_key;
  const { rows: [again] } = await query('SELECT indexnow_key FROM sites WHERE id = $1', [siteId]);
  return again?.indexnow_key || null;
}

/** Records what the ping for a deployment returned, on the deployment's own evidence, so "did we tell Bing?" has an answer. */
export async function recordIndexNowPing(deploymentId, result) {
  await query(
    `UPDATE deployments SET evidence = COALESCE(evidence, '{}'::jsonb) || jsonb_build_object('indexnow', $2::jsonb), updated_at = now() WHERE id = $1`,
    [deploymentId, JSON.stringify({ ok: result.ok, status: result.status ?? null, submitted: result.submitted ?? 0, reason: result.reason ?? null, at: new Date().toISOString() })],
  );
}
