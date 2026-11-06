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
let siteTotalsByWindow;
let deploymentById;

function reset() {
  recordedOutcomes = [];
  recordedImpact = [];
  searchTotalsByWindow = new Map(); // 'start:end' -> totals | null
  siteTotalsByWindow = new Map(); // same keys, the whole-site control
  deploymentById = null;
}
reset();

mock.module(resolve('../../store/fix-impact.js'), {
  namedExports: {
    getDueImpactMeasurements: async () => [],
    recordImpactOutcome: async (id, payload) => { recordedImpact.push({ id, ...payload }); return { id, ...payload }; },
    getPageSearchTotals: async (siteId, page, start, end) => searchTotalsByWindow.get(`${start}:${end}`) ?? null,
    getSiteSearchTotals: async (siteId, start, end) => siteTotalsByWindow.get(`${start}:${end}`) ?? null,
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

const { classifyImpact, classifyImpactEvidence, measureOne } = await import('./fix-impact.js');

const BEFORE_KEY = '2026-06-03:2026-06-30';
const AFTER_KEY = '2026-07-04:2026-07-31';
const flatSite = () => { siteTotalsByWindow.set(BEFORE_KEY, { clicks: 5000, impressions: 400_000 }); siteTotalsByWindow.set(AFTER_KEY, { clicks: 5000, impressions: 400_000 }); };

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
    flatSite();
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
    flatSite();
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

// Phase 2: a label is only a lesson when the evidence supports it. Each case below is a way a naive sign-of-clicks
// rule would have taught the system something false.
describe('measureOne — evidence-qualified impact (Phase 2)', () => {
  const inconclusiveOutcome = () => recordedOutcomes[0];

  test('the page rose, but so did the whole site by the same share: inconclusive, not a win for the generator', async () => {
    reset();
    siteTotalsByWindow.set(BEFORE_KEY, { clicks: 5000, impressions: 400_000 });
    siteTotalsByWindow.set(AFTER_KEY, { clicks: 7500, impressions: 520_000 }); // site +50%, page +50%
    searchTotalsByWindow.set(BEFORE_KEY, before);
    searchTotalsByWindow.set(AFTER_KEY, { ...before, clicks: 150, impressions: 12_000 });

    await measureOne(row);

    assert.equal(inconclusiveOutcome().outcome, 'impact-neutral');
    assert.match(inconclusiveOutcome().opts.detail, /^inconclusive \(moved-with-site\)/);
    assert.equal(recordedImpact[0].delta.verdict, 'impact-inconclusive');
    assert.equal(recordedImpact[0].delta.verdictReason, 'moved-with-site');
  });

  test('the page fell while the whole site fell by the same share: not blamed on the fix', async () => {
    reset();
    siteTotalsByWindow.set(BEFORE_KEY, { clicks: 5000, impressions: 400_000 });
    siteTotalsByWindow.set(AFTER_KEY, { clicks: 3000, impressions: 300_000 }); // site -40%, page -40%
    searchTotalsByWindow.set(BEFORE_KEY, before);
    searchTotalsByWindow.set(AFTER_KEY, { ...before, clicks: 60, impressions: 8_000 });

    await measureOne(row);

    assert.equal(inconclusiveOutcome().outcome, 'impact-neutral');
    assert.equal(recordedImpact[0].delta.verdictReason, 'moved-with-site');
  });

  test('no whole-site data to compare against: inconclusive, never assumed to be a win', async () => {
    reset(); // siteTotalsByWindow left empty
    searchTotalsByWindow.set(BEFORE_KEY, before);
    searchTotalsByWindow.set(AFTER_KEY, { ...before, clicks: 150, impressions: 12_000 });

    await measureOne(row);

    assert.equal(inconclusiveOutcome().outcome, 'impact-neutral');
    assert.equal(recordedImpact[0].delta.verdictReason, 'no-site-control');
  });

  test('a one-click wobble on a small page is not a lesson (the old rule called 12 -> 13 a win)', async () => {
    reset();
    flatSite();
    searchTotalsByWindow.set(BEFORE_KEY, { ...before, clicks: 12 });
    searchTotalsByWindow.set(AFTER_KEY, { ...before, clicks: 13 });

    await measureOne(row);

    assert.equal(inconclusiveOutcome().outcome, 'impact-neutral');
    assert.equal(recordedImpact[0].delta.verdictReason, 'below-material-change');
  });

  test('a material-looking change that is still inside random noise is inconclusive', async () => {
    reset();
    flatSite();
    searchTotalsByWindow.set(BEFORE_KEY, { ...before, clicks: 30 });
    searchTotalsByWindow.set(AFTER_KEY, { ...before, clicks: 40 }); // +10 clicks, +33%, but 2*sqrt(70) = 16.7 of noise

    await measureOne(row);

    assert.equal(recordedImpact[0].delta.verdictReason, 'within-noise');
    assert.equal(inconclusiveOutcome().outcome, 'impact-neutral');
  });

  test('the evidence behind every label is stored with the measurement', async () => {
    reset();
    flatSite();
    searchTotalsByWindow.set(BEFORE_KEY, before);
    searchTotalsByWindow.set(AFTER_KEY, { ...before, clicks: 150, impressions: 12_000 });

    await measureOne(row);

    const d = recordedImpact[0].delta;
    assert.equal(d.verdict, 'impact-positive');
    assert.equal(d.verdictReason, 'supported');
    assert.equal(d.evidence.pageClicksBefore, 100);
    assert.equal(d.evidence.pageClicksAfter, 150);
    assert.equal(d.evidence.pageChangePct, 50);
    assert.equal(d.evidence.siteChangePct, 0);
    assert.equal(d.evidence.adjustedChangePct, 50);
    assert.match(d.caveat, /correlation, not attribution/);
    assert.match(recordedOutcomes[0].opts.detail, /relative to the site's own trend/);
  });
});

describe('classifyImpactEvidence — pure', () => {
  const page = (b) => ({ clicks: b });
  const site = (b, a) => ({ before: { clicks: b }, after: { clicks: a } });

  test('a supported rise and a supported fall', () => {
    assert.equal(classifyImpactEvidence({ clicks: 60 }, page(100), site(1000, 1000)).verdict, 'impact-positive');
    assert.equal(classifyImpactEvidence({ clicks: -50 }, page(100), site(1000, 1000)).verdict, 'impact-negative');
  });

  test('a page that beat a growing site by a clear margin is still a win', () => {
    // page +80% against a site that grew 20%: adjusted +60 points
    const r = classifyImpactEvidence({ clicks: 80 }, page(100), site(1000, 1200));
    assert.equal(r.verdict, 'impact-positive');
    assert.equal(r.evidence.adjustedChangePct, 60);
  });

  test('a page that rose less than the site is not a win even though clicks went up', () => {
    // page +50% (clears material change and noise) against a site that grew 40%: adjusted +10 points, under the 20-point floor
    assert.equal(classifyImpactEvidence({ clicks: 50 }, page(100), site(1000, 1400)).reason, 'moved-with-site');
  });

  test('a page that fell while the site grew is a supported negative', () => {
    // page -30%, site +30%: adjusted -60 points
    assert.equal(classifyImpactEvidence({ clicks: -30 }, page(100), site(1000, 1300)).verdict, 'impact-negative');
  });

  test('missing inputs are inconclusive with a reason, never a verdict', () => {
    assert.equal(classifyImpactEvidence(null, page(100), site(1, 1)).reason, 'no-measurement');
    assert.equal(classifyImpactEvidence({ clicks: 10 }, null, site(1, 1)).reason, 'no-measurement');
    assert.equal(classifyImpactEvidence({ clicks: 10 }, page(0), site(1, 1)).reason, 'no-baseline-clicks');
    assert.equal(classifyImpactEvidence({ clicks: 60 }, page(100), null).reason, 'no-site-control');
    assert.equal(classifyImpactEvidence({ clicks: 60 }, page(100), site(0, 100)).reason, 'no-site-control');
  });

  test('uses the same floors as page suppression, so the two cannot disagree about what is material', async () => {
    const { MIN_REGRESSION_CLICKS, MIN_REGRESSION_SHARE } = await import('../../store/fix-suppressions.js');
    const e = classifyImpactEvidence({ clicks: 60 }, page(100), site(1000, 1000)).evidence;
    assert.equal(e.minClicks, MIN_REGRESSION_CLICKS);
    assert.equal(e.minShare, MIN_REGRESSION_SHARE);
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
