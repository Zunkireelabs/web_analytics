import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runAnalystSyncForAllSites, runAnalystFusionForAllSites } from './job.js';

// The nightly analyst sync and the fusion job must not turn findings into recommendations unless the analyst confirmed a complete
// analysis that covers the site (agents/lib/analyst-findings-gate.js). The analyst service itself must not even be called.
const sites = [{ id: 1, name: 'Zunkiree' }, { id: 8871, name: 'SuperRank' }];
const failIfFetched = () => { throw new Error('the analyst service must not be called for a blocked site'); };

describe('findings gate on the analyst jobs', () => {
  test('sync: with no confirmed analysis every site is blocked and the analyst is never queried', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = failIfFetched;
    try {
      const totals = await runAnalystSyncForAllSites({ listSites: async () => sites, gate: { state: 'missing', reason: 'the analyst has never confirmed a complete analysis' } });
      assert.equal(totals.blocked, 2);
      assert.equal(totals.created, 0);
    } finally { globalThis.fetch = original; }
  });

  test('sync: a site the latest complete analysis did not cover is blocked while a covered site is allowed through the gate', async () => {
    const original = globalThis.fetch;
    const queried = [];
    globalThis.fetch = async (url) => { queried.push(String(url)); return { ok: true, json: async () => ({ insights: [] }) }; };
    process.env.DATA_ANALYST_AGENT_ADMIN_KEY = 'k';
    try {
      const gate = { state: 'complete', covered: new Set([1]), excluded: { 8871: 'run_predictions: page_query is 55 day(s) old' } };
      const totals = await runAnalystSyncForAllSites({ listSites: async () => sites, gate });
      assert.equal(totals.blocked, 1);                                                  // SuperRank blocked
      assert.equal(queried.some((u) => u.includes('/clients/8871/')), false);           // never queried
      assert.equal(queried.some((u) => u.includes('/clients/1/insights')), true);       // Zunkiree was
    } finally { globalThis.fetch = original; delete process.env.DATA_ANALYST_AGENT_ADMIN_KEY; }
  });

  test('fusion: blocked sites are skipped without running fusion; allowed sites run it', async () => {
    const fused = [];
    const totals = await runAnalystFusionForAllSites({
      listSites: async () => sites,
      gate: { state: 'complete', covered: new Set([8871]), excluded: {} },
      fuse: async (id) => { fused.push(id); return { created: 1, monitored: 0, freshness: { verdict: 'fresh' } }; },
    });
    assert.deepEqual(fused, [8871]);
    assert.equal(totals.blocked, 1);
    assert.equal(totals.created, 1);
  });

  test('fusion: a failed analysis (marker not completed) blocks every site', async () => {
    const fused = [];
    const totals = await runAnalystFusionForAllSites({
      listSites: async () => sites,
      gate: { state: 'incomplete', reason: "the analyst's latest analysis did not complete: findings incomplete: run_insight_engine: failed" },
      fuse: async (id) => { fused.push(id); return { created: 0, monitored: 0 }; },
    });
    assert.deepEqual(fused, []);
    assert.equal(totals.blocked, 2);
  });
});
