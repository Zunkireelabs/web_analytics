import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAnalystInsights } from './job.js';

// Regression: fetchAnalystInsights used to hand-roll its own fetch() with no
// headers at all, hitting GET /clients/{siteId}/insights (a route that also
// didn't exist yet — see data-analyst-agent/app/api/routes/dashboard.py's
// _recent_insights, added alongside this fix). Even with the route now
// live, every /clients/{client_id}/* route requires X-Admin-Key
// (app/api/deps.py's get_active_client -> require_admin_key) — a caller
// with no header 401s regardless of whether the route exists. This must go
// through the same shared, admin-key-injecting client every other
// Node->Python call already uses (lib/data-analyst-client.js), not a
// second, bespoke fetch.
describe('fetchAnalystInsights', () => {
  test('calls the Python service with the shared client\'s X-Admin-Key header, at the documented path', async () => {
    process.env.DATA_ANALYST_AGENT_ADMIN_KEY = 'test-admin-key';
    const original = globalThis.fetch;
    let seenUrl, seenHeaders;
    globalThis.fetch = async (url, opts) => {
      seenUrl = url;
      seenHeaders = opts?.headers;
      return { ok: true, json: async () => ({ insights: [{ id: 1, metric_key: 'gsc_impressions' }] }) };
    };
    try {
      const insights = await fetchAnalystInsights(42);
      assert.equal(String(seenUrl).includes('/clients/42/insights'), true);
      assert.equal(seenHeaders['X-Admin-Key'], 'test-admin-key');
      assert.deepEqual(insights, [{ id: 1, metric_key: 'gsc_impressions' }]);
    } finally {
      globalThis.fetch = original;
      delete process.env.DATA_ANALYST_AGENT_ADMIN_KEY;
    }
  });

  test('also accepts a bare array response body, not just {insights: [...]}', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ([{ id: 2 }]) });
    try {
      const insights = await fetchAnalystInsights(42);
      assert.deepEqual(insights, [{ id: 2 }]);
    } finally { globalThis.fetch = original; }
  });

  test('throws on a non-ok response instead of silently returning nothing (caller is the one that must decide whether to skip this site)', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ detail: 'Client not found.' }) });
    try {
      await assert.rejects(() => fetchAnalystInsights(42), /Client not found/);
    } finally { globalThis.fetch = original; }
  });
});
