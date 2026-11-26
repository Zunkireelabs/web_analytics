import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { retryBlockedKeywordDiscovery, _resetForTests } from './keyword-discovery-retry.js';

const sites = [1, 8862, 8871, 8872, 8874].map((id) => ({ id }));
const row = (site_id, status, reason_code) => ({ site_id, status, reason_code });
describe('keyword discovery retry inside the worker window', () => {
  beforeEach(_resetForTests);
  test('only the projects blocked for a worker-fixable reason are retried; the rest are not touched', async () => {
    let got = null;
    const r = await retryBlockedKeywordDiscovery({ now: 1e12, list: async () => [row(8871, 'blocked', 'worker_offline'), row(8872, 'blocked', 'dataforseo_payment_required'), row(8874, 'ok', null), row(1, 'blocked', 'model_failed')],
      listSites: async () => sites, run: async ({ listSites }) => { got = (await listSites()).map((s) => s.id); } });
    assert.deepEqual(got.sort(), [1, 8871]); assert.deepEqual(r.retried.sort(), [1, 8871]);
  });
  test('nothing blocked: nothing runs', async () => {
    let ran = false; const r = await retryBlockedKeywordDiscovery({ now: 1e12, list: async () => [row(1, 'ok', null)], listSites: async () => sites, run: async () => { ran = true; } });
    assert.equal(ran, false); assert.equal(r.skipped, 'nothing-blocked');
  });
  test('throttled: a second call within 3 hours does nothing, one after does', async () => {
    let runs = 0; const deps = { list: async () => [row(8871, 'blocked', 'worker_offline')], listSites: async () => sites, run: async () => { runs++; } };
    await retryBlockedKeywordDiscovery({ ...deps, now: 1e12 });
    assert.equal((await retryBlockedKeywordDiscovery({ ...deps, now: 1e12 + 3600_000 })).skipped, 'throttled');
    await retryBlockedKeywordDiscovery({ ...deps, now: 1e12 + 4 * 3600_000 });
    assert.equal(runs, 2);
  });
});
