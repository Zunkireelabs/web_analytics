import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseDeviceCtrDeficit, MAX_TITLE_LEN } from './device-ctr-diagnosis.js';

const okPage = (overrides = {}) => ({
  ok: true,
  analysis: {
    title: 'A reasonable title',
    hasViewportMeta: true,
    viewportHasDeviceWidth: true,
    ...overrides,
  },
});

describe('diagnoseDeviceCtrDeficit', () => {
  test('position: a meaningfully worse ranking position on this device is sufficient evidence on its own', async () => {
    const result = await diagnoseDeviceCtrDeficit(
      1,
      { device: 'DESKTOP', ctr: 0.01, impressions: 1000, avgPosition: 12 },
      [{ device: 'DESKTOP', avgPosition: 12 }, { device: 'MOBILE', avgPosition: 8 }],
      { start: 's', end: 'e' }
    );
    assert.equal(result.cause, 'position');
    assert.equal(result.fixes.length, 0);
    assert.ok(result.explanation.includes('position'));
  });

  test('a small position gap is not treated as the explanation — falls through to the next check', async () => {
    const result = await diagnoseDeviceCtrDeficit(
      1,
      { device: 'DESKTOP', ctr: 0.01, impressions: 1000, avgPosition: 8.2 },
      [{ device: 'DESKTOP', avgPosition: 8.2 }, { device: 'MOBILE', avgPosition: 8.0 }],
      { start: 's', end: 'e', getPagePerformance: async () => [] }
    );
    assert.notEqual(result.cause, 'position');
  });

  test('desktop/tablet never gets a title-length or viewport cause — those only describe mobile SERP rendering', async () => {
    const result = await diagnoseDeviceCtrDeficit(
      1,
      { device: 'TABLET', ctr: 0.01, impressions: 1000, avgPosition: 8 },
      [{ device: 'TABLET', avgPosition: 8 }, { device: 'DESKTOP', avgPosition: 8 }],
      {
        start: 's', end: 'e',
        getPagePerformance: async () => { throw new Error('must not be called for a non-mobile device'); },
      }
    );
    assert.equal(result.cause, 'undiagnosed');
    assert.equal(result.fixes.length, 0);
  });

  test('viewport: a majority of top mobile pages missing a correct viewport tag -> one sitewide fix', async () => {
    const pages = ['/a', '/b', '/c'];
    const result = await diagnoseDeviceCtrDeficit(
      1,
      { device: 'MOBILE', ctr: 0.01, impressions: 1000, avgPosition: 8 },
      [{ device: 'MOBILE', avgPosition: 8 }, { device: 'DESKTOP', avgPosition: 8 }],
      {
        start: 's', end: 'e',
        getPagePerformance: async () => pages.map((page) => ({ page, clicks: 1, impressions: 100 })),
        fetchPage: async (page) => (page === '/a' ? okPage() : okPage({ hasViewportMeta: false })),
      }
    );
    assert.equal(result.cause, 'viewport');
    assert.equal(result.fixes.length, 1);
    assert.equal(result.fixes[0].scope, 'sitewide');
    assert.equal(result.fixes[0].recommendedAction.generatorId, 'viewport');
  });

  test('title-length: a majority of top mobile pages with an over-length title -> one fix per page, grounded in a real query', async () => {
    const pages = ['/a', '/b', '/c'];
    const longTitle = 'x'.repeat(MAX_TITLE_LEN + 20);
    const result = await diagnoseDeviceCtrDeficit(
      1,
      { device: 'MOBILE', ctr: 0.01, impressions: 1000, avgPosition: 8 },
      [{ device: 'MOBILE', avgPosition: 8 }, { device: 'DESKTOP', avgPosition: 8 }],
      {
        start: 's', end: 'e',
        getPagePerformance: async () => pages.map((page) => ({ page, clicks: 1, impressions: 100 })),
        fetchPage: async (page) => (page === '/a' ? okPage() : okPage({ title: longTitle })),
        getTopQuery: async (siteId, start, end, page) => [{ query: `real query for ${page}` }],
      }
    );
    assert.equal(result.cause, 'title-length');
    assert.equal(result.fixes.length, 2);
    assert.ok(result.fixes.every((f) => f.scope === 'page' && f.recommendedAction.generatorId === 'meta-title'));
    assert.equal(result.fixes[0].recommendedAction.params.query, 'real query for /b');
  });

  test('a single outlier page is never enough — one bad title/viewport out of many is that page\'s own problem, not the device\'s', async () => {
    const pages = ['/a', '/b', '/c', '/d'];
    const result = await diagnoseDeviceCtrDeficit(
      1,
      { device: 'MOBILE', ctr: 0.01, impressions: 1000, avgPosition: 8 },
      [{ device: 'MOBILE', avgPosition: 8 }, { device: 'DESKTOP', avgPosition: 8 }],
      {
        start: 's', end: 'e',
        getPagePerformance: async () => pages.map((page) => ({ page, clicks: 1, impressions: 100 })),
        fetchPage: async (page) => (page === '/a' ? okPage({ hasViewportMeta: false }) : okPage()),
      }
    );
    assert.equal(result.cause, 'undiagnosed');
    assert.equal(result.fixes.length, 0);
  });

  test('undiagnosed carries which checks actually ran, distinguishing "investigated, clean" from "never looked"', async () => {
    const result = await diagnoseDeviceCtrDeficit(
      1,
      { device: 'MOBILE', ctr: 0.01, impressions: 1000, avgPosition: 8 },
      [{ device: 'MOBILE', avgPosition: 8 }, { device: 'DESKTOP', avgPosition: 8 }],
      {
        start: 's', end: 'e',
        getPagePerformance: async () => [{ page: '/a', clicks: 1, impressions: 100 }],
        fetchPage: async () => okPage(),
      }
    );
    assert.equal(result.cause, 'undiagnosed');
    assert.equal(result.evidence.checkedPosition, true);
    assert.equal(result.evidence.checkedTitleLength, true);
    assert.equal(result.evidence.checkedViewport, true);
  });

  test('no other device has a usable position at all -> position check is skipped, not treated as a false pass', async () => {
    const result = await diagnoseDeviceCtrDeficit(
      1,
      { device: 'MOBILE', ctr: 0.01, impressions: 1000, avgPosition: null },
      [{ device: 'MOBILE', avgPosition: null }, { device: 'DESKTOP', avgPosition: null }],
      { start: 's', end: 'e', getPagePerformance: async () => [] }
    );
    assert.notEqual(result.cause, 'position');
  });
});
