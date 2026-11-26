// KEYWORD DISCOVERY THAT WAITED FOR THE WORKER: model research needs the laptop worker, which is closed at the weekly slot. Inside the worker's window (called from its
// existing session tick, no new scheduler) the projects whose discovery was blocked for a reason a connected worker fixes are tried again, at most every 3 hours. Each project
// is still guarded (monthly paid check, de-duplicated saves), so a retry never repeats finished work, and only the blocked projects are touched.
export const RETRYABLE_DISCOVERY = new Set(['worker_offline', 'model_failed', 'model_no_credit', 'no_seed_terms', 'no_offerings_found', 'no_phrases']);
let lastRetryAt = 0;
export const _resetForTests = () => { lastRetryAt = 0; };

export async function retryBlockedKeywordDiscovery({ now = Date.now(), minGapMs = 3 * 3600_000, list = null, run, listSites } = {}) {
  if (now - lastRetryAt < minGapMs) return { skipped: 'throttled' };
  const listStatus = list || (await import('../store/keyword-discovery-status.js')).listDiscoveryStatus;
  const rows = await listStatus();
  const ids = new Set(rows.filter((r) => r.status === 'blocked' && RETRYABLE_DISCOVERY.has(r.reason_code)).map((r) => r.site_id));
  lastRetryAt = now;
  if (!ids.size) return { skipped: 'nothing-blocked', retried: [] };
  const sites = (await listSites()).filter((s) => ids.has(s.id));
  await run({ listSites: async () => sites });
  return { retried: sites.map((s) => s.id) };
}
