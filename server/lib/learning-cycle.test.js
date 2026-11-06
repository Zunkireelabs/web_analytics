import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureBaselines, recordGrowthStagesForSites, BASELINES_PER_RUN, sitesWithNewOutcomes, updateProjectMemoryForSites, runLearningUpdateAfterOutcomes, runDailyLearningUpdate, promoteIndustryKnowledge } from './learning-cycle.js';

const quiet = () => { const o = console.error; console.error = () => {}; return () => { console.error = o; }; };

test('only measured rows count as a learning event, once per site', () => {
  const ids = sitesWithNewOutcomes([
    { status: 'measured', site_id: 1 }, { status: 'measured', site_id: 1 }, { status: 'measured', site_id: '2' },
    { status: 'insufficient-data', site_id: 3 }, null, undefined, { status: 'pending', site_id: 4 },
  ]);
  assert.deepEqual(ids.sort(), [1, 2]);
  assert.deepEqual(sitesWithNewOutcomes(null), []);
});

test('one failing project does not stop the others', async () => {
  const restore = quiet();
  const seen = [];
  const r = await updateProjectMemoryForSites([1, 2, 3], { deps: { snapshotProjectMemory: async (id) => { seen.push(id); if (id === 2) throw new Error('boom'); return { changed: [{ section: 'design' }] }; } } });
  restore();
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(r, { sites: 2, changed: 2, failed: 1 });
});

test('no measured outcome means nothing is touched, not even industry knowledge', async () => {
  let called = 0;
  const deps = { snapshotProjectMemory: async () => { called++; return {}; }, refreshIndustryKnowledge: async () => { called++; } };
  const r = await runLearningUpdateAfterOutcomes([{ status: 'insufficient-data', site_id: 1 }], { deps });
  assert.equal(called, 0);
  assert.equal(r.sites, 0);
});

test('a measured outcome snapshots that project and re-evaluates industry knowledge', async () => {
  const reasons = [];
  const deps = { snapshotProjectMemory: async (id, o) => { reasons.push([id, o.reason]); return { changed: [] }; }, refreshIndustryKnowledge: async () => ({ validated: 0 }) };
  const r = await runLearningUpdateAfterOutcomes([{ status: 'measured', site_id: 7 }], { deps });
  assert.deepEqual(reasons, [[7, 'cron']]);
  assert.deepEqual(r.industry, { validated: 0 });
});

test('industry refresh failure returns null and never throws', async () => {
  const restore = quiet();
  const r = await promoteIndustryKnowledge({ deps: { refreshIndustryKnowledge: async () => { throw new Error('db down'); } } });
  restore();
  assert.equal(r, null);
});

test('daily update covers every connected site and survives a listing failure', async () => {
  const ok = await runDailyLearningUpdate({ deps: { listConnectedSites: async () => [{ id: 1, onboarded_at: 'x' }, { id: 2, onboarded_at: 'x' }], snapshotProjectMemory: async () => ({ changed: [] }), refreshIndustryKnowledge: async () => ({}), loadGrowthStage: async () => null, recordStageEntry: async () => false } });
  assert.equal(ok.sites, 2);
  const restore = quiet();
  const bad = await runDailyLearningUpdate({ deps: { listConnectedSites: async () => { throw new Error('x'); }, refreshIndustryKnowledge: async () => ({}) } });
  restore();
  assert.equal(bad.sites, 0);
});

test('baselines are captured only for projects without one, capped per run, and a failure never stops the rest', async () => {
  const ran = [];
  const sites = [{ id: 1, onboarded_at: 'done' }, ...[2, 3, 4, 5, 6].map((id) => ({ id }))];
  const restore = quiet();
  const r = await ensureBaselines(sites, { deps: { runBaselineSequence: async (id) => { ran.push(id); if (id === 3) throw new Error('google not ready'); } } });
  restore();
  assert.deepEqual(ran, [2, 3, 4], `at most ${BASELINES_PER_RUN} per run, skipping the baselined project`);
  assert.deepEqual(r, { missing: 5, attempted: 3, ok: 2, failed: 1 });
});

test('with every project baselined, no baseline work happens at all', async () => {
  let called = 0;
  const r = await ensureBaselines([{ id: 1, onboarded_at: 'x' }], { deps: { runBaselineSequence: async () => { called++; } } });
  assert.equal(called, 0);
  assert.equal(r.missing, 0);
});

test('a growth stage is recorded the first time a project reaches it, and a failing project does not stop the others', async () => {
  const entered = new Set();
  const restore = quiet();
  const r = await recordGrowthStagesForSites([1, 2, 3], { deps: {
    loadGrowthStage: async (id) => { if (id === 2) throw new Error('db'); return { stage: 'acceleration', label: 'Growth Acceleration', day: 1 }; },
    recordStageEntry: async (id, g) => { const k = `${id}:${g.stage}`; if (entered.has(k)) return false; entered.add(k); return true; },
  } });
  restore();
  assert.deepEqual(r.entered.map((e) => e.siteId), [1, 3]);
  assert.equal(r.failed, 1);
  const again = await recordGrowthStagesForSites([1, 3], { deps: { loadGrowthStage: async () => ({ stage: 'acceleration', label: 'x', day: 2 }), recordStageEntry: async (id, g) => { const k = `${id}:${g.stage}`; if (entered.has(k)) return false; entered.add(k); return true; } } });
  assert.deepEqual(again.entered, [], 'idempotent: already-recorded stages are not recorded again');
});
