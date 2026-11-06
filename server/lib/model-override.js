// What llm.js asks before an AI call: "has a model been deliberately promoted for this role?". Deliberately tiny and free of
// imports from the decision engine or the registry code, so llm.js can use it without an import cycle.
//
// ON unless MODEL_REGISTRY is explicitly disabled, and harmless in that state: with no active registry row the answer is null
// and the call uses exactly the model it always did. A promoted model only ever exists after beating the incumbent on a held-out
// evaluation with a named admin's sign-off (lib/model-adaptation.js promoteModel). Cached briefly so it is not a query per call;
// a failed lookup falls back to the existing configuration and is logged once per outage, never thrown.
import { onUnlessDisabled } from './feature-flags.js';

const TTL_MS = 60 * 1000;
const cache = new Map(); // role -> { at, value }
let warnedAt = 0;

export function clearModelOverrideCache() { cache.clear(); warnedAt = 0; }

export async function activeModelFor(role, { env = process.env, now = Date.now(), query = null } = {}) {
  if (!role || !onUnlessDisabled(env.MODEL_REGISTRY)) return null;
  const hit = cache.get(role);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  let value = null;
  try {
    const q = query || (await import('../db.js')).query;
    const { rows } = await q(`SELECT provider, model_id FROM model_registry WHERE role = $1 AND status = 'active' LIMIT 1`, [role]);
    value = rows[0] ? { provider: rows[0].provider, model: rows[0].model_id } : null;
  } catch (err) {
    if (now - warnedAt > 10 * 60 * 1000) {
      warnedAt = now;
      console.warn(`[model-registry] could not read the active model (${err.message}) — using the configured default model. Recovery: check the database and that migration 229 has run.`);
    }
  }
  cache.set(role, { at: now, value });
  return value;
}
