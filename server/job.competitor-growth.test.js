import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  competitorGrowthDue, runCompetitorGrowthCycleForAllSites, runCompetitorOutcomeLearningForAllSites,
  rankTrackingDue, runRankTrackingForAllSites,
} from './job.js';

// The property that makes this safe to deploy: with no site opted in, nothing runs, nothing is spent and no provider
// is called. After that, per-site isolation and the cadence stamp are what stop one tenant's outage from costing
// every tenant a retry every night.

const site = (over = {}) => ({ id: 1, name: 'Test site', timezone: 'UTC', ...over });

describe('competitorGrowthDue', () => {
  test('a site that has never run is due', () => {
    assert.equal(competitorGrowthDue(site({ competitor_growth_last_done: null })), true);
  });

  test('a site that ran today is not due', () => {
    assert.equal(competitorGrowthDue(site({ competitor_growth_last_done: new Date() })), false);
  });

  test('the interval is honoured and configurable', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400000);
    assert.equal(competitorGrowthDue(site({ competitor_growth_last_done: fiveDaysAgo }), { intervalDays: 7 }), false);
    assert.equal(competitorGrowthDue(site({ competitor_growth_last_done: fiveDaysAgo }), { intervalDays: 3 }), true);
  });

  test('a stamp exactly at the interval is due', () => {
    const now = new Date('2026-11-12T00:00:00Z');
    const sevenDaysBefore = new Date('2026-11-05T00:00:00Z');
    assert.equal(competitorGrowthDue(site({ competitor_growth_last_done: sevenDaysBefore }), { now, intervalDays: 7 }), true);
  });
});

describe('runCompetitorGrowthCycleForAllSites', () => {
  test('no opted-in site means nothing runs and nothing is spent', async () => {
    let called = 0;
    const totals = await runCompetitorGrowthCycleForAllSites({
      listSitesFn: async () => [],
      runCycle: async () => { called += 1; return {}; },
    });
    assert.deepEqual(totals, { sites: 0, ran: 0, skipped: 0, costUsd: 0, opportunities: 0 });
    assert.equal(called, 0);
  });

  test('an opted-in, due site runs and its spend and opportunities are totalled', async () => {
    const marked = [];
    const totals = await runCompetitorGrowthCycleForAllSites({
      listSitesFn: async () => [site({ competitor_growth_last_done: null })],
      runCycle: async () => ({ costUsd: 0.12, opportunities: { ran: true, built: 4, written: { inserted: 3, updated: 1 } } }),
      markDone: async (id) => marked.push(id),
    });
    assert.equal(totals.ran, 1);
    assert.equal(totals.opportunities, 3);
    assert.ok(Math.abs(totals.costUsd - 0.12) < 1e-9);
    assert.deepEqual(marked, [1]);
  });

  test('a site that is not yet due is skipped without a cycle call', async () => {
    let called = 0;
    const totals = await runCompetitorGrowthCycleForAllSites({
      listSitesFn: async () => [site({ competitor_growth_last_done: new Date() })],
      runCycle: async () => { called += 1; return {}; },
      markDone: async () => {},
    });
    assert.equal(totals.skipped, 1);
    assert.equal(totals.ran, 0);
    assert.equal(called, 0);
  });

  test('the cadence is stamped even when a stage was refused, so a bad night is not retried every night', async () => {
    const marked = [];
    await runCompetitorGrowthCycleForAllSites({
      listSitesFn: async () => [site({ competitor_growth_last_done: null })],
      runCycle: async () => ({ costUsd: 0, opportunities: { ran: false, reason: 'no_footprint_yet' } }),
      markDone: async (id) => marked.push(id),
    });
    assert.deepEqual(marked, [1]);
  });

  test('one site throwing does not stop the others, and the failed one is not stamped', async () => {
    const marked = [];
    const totals = await runCompetitorGrowthCycleForAllSites({
      listSitesFn: async () => [
        site({ id: 1, competitor_growth_last_done: null }),
        site({ id: 2, competitor_growth_last_done: null }),
      ],
      runCycle: async (s) => {
        if (s.id === 1) throw new Error('provider down');
        return { costUsd: 0.05, opportunities: { ran: true, built: 1, written: { inserted: 1, updated: 0 } } };
      },
      markDone: async (id) => marked.push(id),
    });
    assert.equal(totals.sites, 2);
    assert.equal(totals.ran, 1);
    assert.deepEqual(marked, [2]);
  });

  test('a cycle report with no cost or opportunities still counts as a run', async () => {
    const totals = await runCompetitorGrowthCycleForAllSites({
      listSitesFn: async () => [site({ competitor_growth_last_done: null })],
      runCycle: async () => ({}),
      markDone: async () => {},
    });
    assert.equal(totals.ran, 1);
    assert.equal(totals.costUsd, 0);
  });
});

describe('runCompetitorOutcomeLearningForAllSites', () => {
  test('no opted-in site means no work', async () => {
    let called = 0;
    const totals = await runCompetitorOutcomeLearningForAllSites({
      listSitesFn: async () => [],
      learn: async () => { called += 1; return {}; },
    });
    assert.deepEqual(totals, { sites: 0, advanced: 0, counted: 0 });
    assert.equal(called, 0);
  });

  test('it totals lifecycle changes and counted outcomes across sites', async () => {
    const totals = await runCompetitorOutcomeLearningForAllSites({
      listSitesFn: async () => [site({ id: 1 }), site({ id: 2 })],
      learn: async (siteId) => (siteId === 1
        ? { advanced: [{}, {}], counted: [{}] }
        : { advanced: [], counted: [] }),
    });
    assert.equal(totals.sites, 2);
    assert.equal(totals.advanced, 2);
    assert.equal(totals.counted, 1);
  });

  test('it runs for every opted-in site regardless of the paid cycle\'s cadence', async () => {
    const seen = [];
    await runCompetitorOutcomeLearningForAllSites({
      listSitesFn: async () => [site({ id: 1, competitor_growth_last_done: new Date() })],
      learn: async (siteId) => { seen.push(siteId); return { advanced: [], counted: [] }; },
    });
    assert.deepEqual(seen, [1], 'learning is free and must not wait for the paid interval');
  });

  test('one site failing does not stop the others', async () => {
    const totals = await runCompetitorOutcomeLearningForAllSites({
      listSitesFn: async () => [site({ id: 1 }), site({ id: 2 })],
      learn: async (siteId) => {
        if (siteId === 1) throw new Error('db down');
        return { advanced: [{}], counted: [{}] };
      },
    });
    assert.equal(totals.sites, 2);
    assert.equal(totals.counted, 1);
  });
});

describe('rank tracking scheduling', () => {
  test('a site that has never run is due; one that just ran is not', () => {
    assert.equal(rankTrackingDue({ rank_tracking_last_done: null }), true);
    assert.equal(rankTrackingDue({ rank_tracking_last_done: new Date() }), false);
  });

  test('no opted-in site means no call and no spend', async () => {
    let called = 0;
    const totals = await runRankTrackingForAllSites({
      listSitesFn: async () => [],
      check: async () => { called += 1; return { checked: [], costUsd: 0 }; },
    });
    assert.deepEqual(totals, { sites: 0, ran: 0, skipped: 0, keywords: 0, costUsd: 0 });
    assert.equal(called, 0);
  });

  test("the site's own ceiling is used as the run limit", async () => {
    let limit = null;
    await runRankTrackingForAllSites({
      listSitesFn: async () => [{ id: 1, name: 'S', rank_tracking_max_keywords: 10, rank_tracking_last_done: null }],
      check: async (_site, opts) => { limit = opts.limit; return { checked: [], costUsd: 0 }; },
      markDone: async () => {},
    });
    assert.equal(limit, 10);
  });

  test('a due site runs, and its keywords and real cost are totalled', async () => {
    const marked = [];
    const totals = await runRankTrackingForAllSites({
      listSitesFn: async () => [{ id: 1, name: 'S', rank_tracking_max_keywords: 25, rank_tracking_last_done: null }],
      check: async () => ({ checked: [{ keyword: 'a', position: 3 }, { keyword: 'b', position: null }], costUsd: 0.004 }),
      markDone: async (id) => marked.push(id),
    });
    assert.equal(totals.ran, 1);
    assert.equal(totals.keywords, 2);
    assert.ok(Math.abs(totals.costUsd - 0.004) < 1e-9);
    assert.deepEqual(marked, [1]);
  });

  test('one site failing does not stop the others, and the failed one is retried', async () => {
    const marked = [];
    const totals = await runRankTrackingForAllSites({
      listSitesFn: async () => [
        { id: 1, name: 'A', rank_tracking_last_done: null },
        { id: 2, name: 'B', rank_tracking_last_done: null },
      ],
      check: async (s) => {
        if (s.id === 1) throw new Error('provider down');
        return { checked: [{ keyword: 'x', position: 1 }], costUsd: 0.002 };
      },
      markDone: async (id) => marked.push(id),
    });
    assert.equal(totals.ran, 1);
    assert.deepEqual(marked, [2]);
  });
});
