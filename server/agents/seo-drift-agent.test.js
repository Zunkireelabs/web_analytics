import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// The agent's rollout controls. The store is mocked so no database is touched, which also proves the OFF switch does nothing at all
// (not even a site lookup).
let reads; let driftArgs;
mock.module(new URL('../store/read.js', import.meta.url).href, { namedExports: {
  getSiteById: async () => { reads.push('site'); return { id: 1, website_domain: 'example.com' }; },
  getSearchPerformanceRange: async (_s, _a, _b, _dim, limit) => { reads.push(`pages:${limit}`); return []; },
} });
mock.module(new URL('./lib/seo-drift-runner.js', import.meta.url).href, { namedExports: {
  MAX_PAGES: 25,
  pickPages: ({ topPages, max }) => { driftArgs = { topPages, max }; return ['https://example.com/']; },
  runDrift: async () => ({ pagesChecked: 1, firstCaptures: 1, unverifiable: 0, suppressedOwnChanges: 0, findings: [], checkedPages: ['https://example.com/'], history: [] }),
} });
const { run, driftEnabled, driftMaxPages } = await import('./seo-drift.js');

const KEYS = ['SEO_DRIFT_DISABLED', 'SEO_DRIFT_MAX_PAGES'];
let saved;
beforeEach(() => { reads = []; driftArgs = null; saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); KEYS.forEach((k) => delete process.env[k]); });
afterEach(() => KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

describe('driftEnabled / driftMaxPages', () => {
  test('on by default; off for true/1/on/yes in any case; anything else leaves it on', () => {
    assert.equal(driftEnabled({}), true);
    for (const v of ['true', 'TRUE', '1', 'on', 'yes', ' true ']) assert.equal(driftEnabled({ SEO_DRIFT_DISABLED: v }), false, v);
    for (const v of ['false', '0', '', 'no', 'off']) assert.equal(driftEnabled({ SEO_DRIFT_DISABLED: v }), true, v);
  });
  test('page cap: 25 by default, configurable, never below 1 or above 100, junk falls back', () => {
    assert.equal(driftMaxPages({}), 25);
    assert.equal(driftMaxPages({ SEO_DRIFT_MAX_PAGES: '10' }), 10);
    assert.equal(driftMaxPages({ SEO_DRIFT_MAX_PAGES: '9999' }), 100);
    assert.equal(driftMaxPages({ SEO_DRIFT_MAX_PAGES: '-5' }), 1);
    assert.equal(driftMaxPages({ SEO_DRIFT_MAX_PAGES: 'lots' }), 25);
  });
});

describe('run', () => {
  test('switched off: returns a plain "off" result and reads nothing at all', async () => {
    process.env.SEO_DRIFT_DISABLED = 'true';
    const r = await run({ siteId: 1, start: '2026-11-01', end: '2026-11-20' });
    assert.equal(r.status, 'insufficient-data');
    assert.match(r.message, /switched off/);
    assert.equal(r.facts, null);
    assert.deepEqual(reads, []);
  });

  test('the configured cap is used both to read the top pages and to pick them', async () => {
    process.env.SEO_DRIFT_MAX_PAGES = '7';
    const r = await run({ siteId: 1, start: '2026-11-01', end: '2026-11-20' });
    assert.equal(r.status, 'ok');
    assert.ok(reads.includes('pages:7'));
    assert.equal(driftArgs.max, 7);
  });

  test('a re-check of one page asks for no top pages and watches only that page', async () => {
    const r = await run({ siteId: 1, start: '2026-11-01', end: '2026-11-20', params: { pages: ['https://example.com/a/'] } });
    assert.equal(r.status, 'ok');
    assert.deepEqual(driftArgs.topPages, ['https://example.com/a/']);
    assert.ok(!reads.some((x) => x.startsWith('pages:')));
  });
});
