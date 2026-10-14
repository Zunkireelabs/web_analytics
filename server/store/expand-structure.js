import { query } from '../db.js';
import { validateExpandStructureSpec } from '../design-agent/lib/expand-structure-spec.js';

// Versioned global reference data (migration 188). Reads are cached briefly:
// the spec changes only when someone deliberately re-derives it.
const TTL_MS = 5 * 60 * 1000;
let cache = null;

export function clearExpandStructureCache() { cache = null; }

export async function getLatestExpandStructureSpec() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const { rows } = await query('SELECT version, spec FROM expand_structure_specs ORDER BY version DESC LIMIT 1');
  const row = rows[0] || null;
  // Re-validated on READ as well as on write: a row edited by hand in the
  // database must not be able to put identity into a prompt.
  const value = row && validateExpandStructureSpec(row.spec).ok ? row : null;
  cache = { at: Date.now(), value };
  return value;
}

// Refuses an invalid spec outright — the validator is the identity firewall
// and this is the only write path, so a leak can never be persisted.
export async function saveExpandStructureSpec(spec, { derivedFromSiteId = null, pagesObserved = null } = {}) {
  const verdict = validateExpandStructureSpec(spec);
  if (!verdict.ok) throw new Error(`Refusing to persist an invalid structure spec: ${verdict.errors.join('; ')}`);
  const { rows } = await query(
    `INSERT INTO expand_structure_specs (version, spec, derived_from_site_id, pages_observed)
     VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM expand_structure_specs), $1, $2, $3)
     RETURNING id, version`,
    [JSON.stringify(spec), derivedFromSiteId, pagesObserved]
  );
  clearExpandStructureCache();
  return rows[0];
}
