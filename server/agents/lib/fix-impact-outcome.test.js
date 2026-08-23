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

function reset() {
  recordedOutcomes = [];
  recordedImpact = [];
  searchTotalsByWindow = new Map(); // 'start:end' -> totals | null
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
