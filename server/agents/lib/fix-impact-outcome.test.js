import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// Same `mock.module` approach as auto-remediation.test.js: what's under test
// here is fix-impact.js's OWN control flow (which outcome gets logged, and
// when), not the SQL underneath it — store/fix-impact.js and
// generator-learning.js are both mocked. The module under test (including
// classifyImpact, a pure function) is imported dynamically, after the mocks
// are registered below: a STATIC top-level import of anything from
// './fix-impact.js' would eagerly bind its internal store/generator-learning
// imports to the real modules before mock.module runs, and ES module
// instances are cached by resolved URL — a real-bound instance would be
// reused for a later dynamic import too.
const resolve = (p) => new URL(p, import.meta.url).href;

const before = { clicks: 100, impressions: 10_000, ctr: 0.01, avgPosition: 12.4, start: '2026-06-01', end: '2026-06-28' };

let recordedOutcomes;
let recordedImpact;
let searchTotalsByWindow;
let deploymentById;

function reset() {
  recordedOutcomes = [];
  recordedImpact = [];
  searchTotalsByWindow = new Map(); // 'start:end' -> totals | null
  deploymentById = null;
}
reset();

mock.module(resolve('../../store/fix-impact.js'), {
  namedExports: {
    getDueImpactMeasurements: async () => [],
    recordImpactOutcome: async (id, payload) => { recordedImpact.push({ id, ...payload }); return { id, ...payload }; },
    getPageSearchTotals: async (siteId, page, start, end) => searchTotalsByWindow.get(`${start}:${end}`) ?? null,
    IMPACT_WINDOW_DAYS: 28,
  },
});
mock.module(resolve('./generator-learning.js'), {
  namedExports: {
    recordOutcome: async (siteId, generatorId, outcome, opts) => { recordedOutcomes.push({ siteId, generatorId, outcome, opts }); },
  },
});

mock.module(resolve('../../store/deployments.js'), {
  namedExports: {
    getDeploymentById: async (id) => deploymentById,
    // Real function, not a stub — same grace-window math fix-verification.js
    // relies on, so a test asserting "within grace" / "grace elapsed" is
    // asserting the actual rule, not a test-only shortcut.
    deploymentGraceElapsed: (deployment, now = new Date()) => {
      if (!deployment?.merged_at) return false;
      return now.getTime() - new Date(deployment.merged_at).getTime() > 6 * 60 * 60 * 1000;
    },
  },
});

const { classifyImpact, measureOne } = await import('./fix-impact.js');

const row = { id: 1, site_id: 5, draft_id: 9, page_url: '/p', generator_id: 'expand-content', merged_at: '2026-07-01T00:00:00Z' };

describe('classifyImpact — pure classification of an already-computed delta', () => {
  test('a real clicks increase is impact-positive', () => {
    assert.equal(classifyImpact({ clicks: 12 }), 'impact-positive');
  });

  test('a real clicks decrease is impact-negative', () => {
    assert.equal(classifyImpact({ clicks: -7 }), 'impact-negative');
  });

  test('no change in clicks is impact-neutral', () => {
    assert.equal(classifyImpact({ clicks: 0 }), 'impact-neutral');
  });
});

describe('measureOne — logs (or withholds) an outcome for the learning loop', () => {
  test('a real measured improvement records impact-positive, keyed to the right site/generator/draft', async () => {
    reset();
    searchTotalsByWindow.set('2026-06-03:2026-06-30', before);
    searchTotalsByWindow.set('2026-07-04:2026-07-31', { ...before, clicks: 150, impressions: 12_000 });

    await measureOne(row);

    assert.equal(recordedImpact[0].status, 'measured');
    assert.equal(recordedOutcomes.length, 1);
    assert.deepEqual(
      { siteId: recordedOutcomes[0].siteId, generatorId: recordedOutcomes[0].generatorId, outcome: recordedOutcomes[0].outcome },
      { siteId: 5, generatorId: 'expand-content', outcome: 'impact-positive' },
    );
    assert.equal(recordedOutcomes[0].opts.draftId, 9);
  });

  test('a real measured decline records impact-negative', async () => {
    reset();
    searchTotalsByWindow.set('2026-06-03:2026-06-30', before);
    searchTotalsByWindow.set('2026-07-04:2026-07-31', { ...before, clicks: 60, impressions: 8_000 });

    await measureOne(row);

    assert.equal(recordedOutcomes[0].outcome, 'impact-negative');
  });

  test('an unchanged page records impact-neutral, not silence and not a failure', async () => {
    reset();
    searchTotalsByWindow.set('2026-06-03:2026-06-30', before);
    searchTotalsByWindow.set('2026-07-04:2026-07-31', before);

    await measureOne(row);

    assert.equal(recordedOutcomes[0].outcome, 'impact-neutral');
  });

  test('insufficient-data (no baseline or no post-window data) never logs an outcome at all', async () => {
    reset();
    // before window has data, after window does not (getPageSearchTotals returns null)
    searchTotalsByWindow.set('2026-06-03:2026-06-30', before);

    await measureOne(row);

    assert.equal(recordedImpact[0].status, 'insufficient-data');
    assert.equal(recordedOutcomes.length, 0, 'no data must never be recorded as a neutral/negative learning signal');
  });
});

// 2026-09 lifecycle-gap audit finding #2: scheduleImpactMeasurement used to
// assume a merge WAS a live deploy. These assert measureOne now consults the
// same deployments.js record fix-verification.js's live re-check promotes,
// before trusting real GSC data against an unconfirmed merge date.
describe('measureOne — deployment gate (2026-09 lifecycle-gap audit finding #2)', () => {
  const rowWithDeployment = { ...row, deployment_id: 42 };

  test('no deployment_id on the row: measures exactly as before this existed', async () => {
    reset();
    searchTotalsByWindow.set('2026-06-03:2026-06-30', before);
    searchTotalsByWindow.set('2026-07-04:2026-07-31', { ...before, clicks: 150, impressions: 12_000 });

    await measureOne(row); // no deployment_id field at all

    assert.equal(recordedImpact[0].status, 'measured');
  });

  test('deployment already confirmed live: measures normally', async () => {
    reset();
    deploymentById = { id: 42, status: 'deployed', merged_at: '2026-07-01T00:00:00Z' };
    searchTotalsByWindow.set('2026-06-03:2026-06-30', before);
    searchTotalsByWindow.set('2026-07-04:2026-07-31', { ...before, clicks: 150, impressions: 12_000 });

    await measureOne(rowWithDeployment);

    assert.equal(recordedImpact[0].status, 'measured');
  });

  test('deployment still pending, within grace window: neither measures nor records insufficient-data — left pending for the next sweep', async () => {
    reset();
    deploymentById = { id: 42, status: 'pending', merged_at: new Date().toISOString() }; // just merged
    searchTotalsByWindow.set('2026-06-03:2026-06-30', before);
    searchTotalsByWindow.set('2026-07-04:2026-07-31', { ...before, clicks: 150, impressions: 12_000 });

    const result = await measureOne(rowWithDeployment);

    assert.equal(result, null, 'no outcome recorded yet — not a verdict, just "not confirmed live yet"');
    assert.equal(recordedImpact.length, 0);
    assert.equal(recordedOutcomes.length, 0);
  });

  test('deployment still pending, grace window elapsed: records insufficient-data rather than measuring an unconfirmed merge', async () => {
    reset();
    deploymentById = { id: 42, status: 'pending', merged_at: '2020-01-01T00:00:00Z' }; // long past the grace window
    // Real GSC data IS available for both windows — proving this is a real
    // suppression, not just "no data happened to exist".
    searchTotalsByWindow.set('2026-06-03:2026-06-30', before);
    searchTotalsByWindow.set('2026-07-04:2026-07-31', { ...before, clicks: 150, impressions: 12_000 });

    await measureOne(rowWithDeployment);

    assert.equal(recordedImpact[0].status, 'insufficient-data');
    assert.equal(recordedImpact[0].beforeWindow.reason, 'deployment-not-detected');
    assert.equal(recordedOutcomes.length, 0, 'an unconfirmed deploy must never be logged as a neutral/negative learning signal');
  });

  test('deployment record itself missing (row references an id that no longer resolves): falls back to measuring, same as no deployment_id', async () => {
    reset();
    deploymentById = null; // getDeploymentById returns nothing
    searchTotalsByWindow.set('2026-06-03:2026-06-30', before);
    searchTotalsByWindow.set('2026-07-04:2026-07-31', { ...before, clicks: 150, impressions: 12_000 });

    await measureOne(rowWithDeployment);

    assert.equal(recordedImpact[0].status, 'measured');
  });
});
