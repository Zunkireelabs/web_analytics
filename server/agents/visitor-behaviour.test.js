import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { run, meta } from './visitor-behaviour.js';

const summary = (over = {}) => ({
  days: 28, measured_days: 28, sessions: 1000,
  topDropOffs: [{ event: 'page: /pricing', sessions_ending_here: 300 }, { event: 'page: /thank-you', sessions_ending_here: 200 }],
  ...over,
});
const deps = (over = {}) => ({
  getPosthogSummary: async () => summary(),
  getProductGrowthConfig: async () => null,
  now: new Date('2026-11-05T12:00:00Z'),
  ...over,
});

describe('visitor-behaviour agent', () => {
  test('it is a recommendation agent that costs nothing to run', () => {
    assert.equal(meta.id, 'visitor-behaviour');
    assert.ok(Array.isArray(meta.dataSources));
  });

  test('a project without PostHog gets an honest insufficient-data, not an error', async () => {
    const out = await run({ siteId: 1, deps: deps({ getPosthogSummary: async () => null }) });
    assert.equal(out.status, 'insufficient-data');
    assert.match(out.message, /not connected/);
  });

  test('a read failure degrades to the same quiet answer', async () => {
    const out = await run({ siteId: 1, deps: deps({ getPosthogSummary: async () => { throw new Error('db'); } }) });
    assert.equal(out.status, 'insufficient-data');
  });

  test('too little history says how much more is needed', async () => {
    const out = await run({ siteId: 1, deps: deps({ getPosthogSummary: async () => summary({ measured_days: 5 }) }) });
    assert.equal(out.status, 'insufficient-data');
    assert.match(out.message, /5 day\(s\).*at least 14/);
  });

  test('a real drop-off becomes a finding; the thank-you page does not', async () => {
    const out = await run({ siteId: 1, deps: deps() });
    assert.equal(out.status, 'ok');
    assert.deepEqual(out.facts.findings.map((f) => f.id), ['visitor-behaviour:drop-off:page: /pricing']);
  });

  test('the finding carries the evidence and no fabricated fix', async () => {
    const [f] = (await run({ siteId: 1, deps: deps() })).facts.findings;
    assert.equal(f.evidence.visits, 300);
    assert.equal(f.evidence.sharePct, 30);
    assert.equal(f.priority, 'high');
    assert.equal(f.recommendedAction, null, 'no generator can safely act on "people stop here"');
    assert.match(f.whyItMatters, /not why/);
  });

  test("the client's own goal event keeps a step out of the findings", async () => {
    const out = await run({ siteId: 1, deps: deps({
      getProductGrowthConfig: async () => ({ conversion_event: 'page: /pricing' }),
    }) });
    assert.deepEqual(out.facts.findings, []);
  });

  test('the window ends yesterday', async () => {
    let asked = null;
    await run({ siteId: 1, deps: deps({ getPosthogSummary: async (_id, start, end) => { asked = { start, end }; return summary(); } }) });
    assert.deepEqual(asked, { start: '2026-10-08', end: '2026-11-04' });
  });

  test('a project with healthy behaviour yields ok with no findings, not a manufactured one', async () => {
    const out = await run({ siteId: 1, deps: deps({ getPosthogSummary: async () => summary({ topDropOffs: [{ event: 'page: /about', sessions_ending_here: 50 }] }) }) });
    assert.equal(out.status, 'ok');
    assert.deepEqual(out.facts.findings, []);
  });
});
