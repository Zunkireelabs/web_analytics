import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { backfillPosthog } from './posthog-backfill.js';
import { fetchPosthogRange } from '../ingest/posthog.js';

const creds = { projectId: '1', apiKey: 'k', host: 'https://us.posthog.com' };
const day = (date) => ({ date, totals: { events: 10, people: 3, pageviews: 6, sessions: 4 }, dropOffs: [{ event: 'page: /pricing', sessionsEndingHere: 2 }], topActions: [{ label: 'Faq opened', raw: 'faq_opened', times: 3 }] });

function harness({ credentials = creds, range = { ok: true, days: [day('2026-11-03'), day('2026-11-04')] } } = {}) {
  const calls = { range: [], saved: [], status: [] };
  return {
    calls,
    deps: {
      getPosthogCredentials: async () => credentials,
      fetchPosthogRange: async (c, start, end) => { calls.range.push({ start, end }); return typeof range === 'function' ? range() : range; },
      upsertPosthogDay: async (siteId, row) => { calls.saved.push({ siteId, ...row }); },
      recordPosthogStatus: async (siteId, ok, detail) => { calls.status.push({ siteId, ok, detail }); },
    },
  };
}
const now = new Date('2026-11-05T12:00:00Z');

describe('backfillPosthog', () => {
  test('imports each returned day and marks the connection healthy', async () => {
    const h = harness();
    const out = await backfillPosthog(1, { now, deps: h.deps });
    assert.equal(out.ok, true);
    assert.equal(out.imported, 2);
    assert.deepEqual(h.calls.saved.map((s) => s.date), ['2026-11-03', '2026-11-04']);
    assert.deepEqual(h.calls.status, [{ siteId: 1, ok: true, detail: undefined }]);
  });

  test('each day is saved with its clicks and form steps as well as its totals and drop-offs', async () => {
    const h = harness();
    await backfillPosthog(1, { now, deps: h.deps });
    assert.deepEqual(h.calls.saved[0].topActions, [{ label: 'Faq opened', raw: 'faq_opened', times: 3 }]);
    assert.equal(h.calls.saved[0].dropOffs.length, 1);
  });

  test('a day from an older fetch without actions is saved with none (the store keeps any earlier good result)', async () => {
    const h = harness({ range: { ok: true, days: [{ date: '2026-11-03', totals: {}, dropOffs: [] }] } });
    await backfillPosthog(1, { now, deps: h.deps });
    assert.deepEqual(h.calls.saved[0].topActions, []);
  });

  test('a sign-in that could not be refreshed reports the real reason on the connection and imports nothing', async () => {
    const h = harness({ credentials: { projectId: '1', host: 'https://us.posthog.com', apiKey: null, authError: { reason: 'unauthorized', detail: 'PostHog access was revoked or has expired.' } } });
    const out = await backfillPosthog(1, { now, deps: { ...h.deps, fetchPosthogRange } });
    assert.deepEqual([out.ok, out.reason, out.imported], [false, 'unauthorized', 0]);
    assert.deepEqual(h.calls.status, [{ siteId: 1, ok: false, detail: 'PostHog access was revoked or has expired.' }]);
    assert.equal(h.calls.saved.length, 0);
  });

  test('a transient failure (outage, timeout, rate limit) is reported but does NOT mark the connection, so the nightly job still runs', async () => {
    for (const reason of ['unreachable', 'failed']) {
      const h = harness({ range: { ok: false, reason, detail: 'ETIMEDOUT' } });
      const out = await backfillPosthog(1, { now, deps: h.deps });
      assert.deepEqual([out.ok, out.reason, out.imported], [false, reason, 0]);
      assert.deepEqual(h.calls.status, [], reason);
    }
  });

  test('a failure about the connection itself (refused, project gone, unusable address) does mark it', async () => {
    for (const reason of ['unauthorized', 'project_not_found', 'bad_host']) {
      const h = harness({ range: { ok: false, reason, detail: `because ${reason}` } });
      await backfillPosthog(1, { now, deps: h.deps });
      assert.deepEqual(h.calls.status, [{ siteId: 1, ok: false, detail: `because ${reason}` }], reason);
    }
  });

  test('the window ends yesterday and spans 30 days by default, so a partial today is never stored as final', async () => {
    const h = harness();
    await backfillPosthog(1, { now, deps: h.deps });
    assert.deepEqual(h.calls.range[0], { start: '2026-10-06', end: '2026-11-04' });
  });

  test('the span is configurable but capped', async () => {
    const h = harness();
    await backfillPosthog(1, { days: 7, now, deps: h.deps });
    assert.equal(h.calls.range[0].start, '2026-10-29');
    const big = harness();
    await backfillPosthog(1, { days: 5000, now, deps: big.deps });
    assert.equal(big.calls.range[0].start, '2026-08-07', 'capped at 90 days');
  });

  test('a project that is not connected imports nothing and does not throw', async () => {
    const h = harness({ credentials: null });
    const out = await backfillPosthog(1, { now, deps: h.deps });
    assert.equal(out.reason, 'not_connected');
    assert.equal(h.calls.range.length, 0);
  });

  test('a key without events access is reported on the connection, in words', async () => {
    const h = harness({ range: { ok: false, reason: 'unauthorized', detail: 'PostHog rejected the API key' } });
    const out = await backfillPosthog(1, { now, deps: h.deps });
    assert.equal(out.ok, false);
    assert.equal(out.imported, 0);
    assert.deepEqual(h.calls.status, [{ siteId: 1, ok: false, detail: 'PostHog rejected the API key' }]);
  });

  test('an unexpected exception is returned, never thrown into a background task', async () => {
    const h = harness({ range: () => { throw new Error('boom'); } });
    const out = await backfillPosthog(1, { now, deps: h.deps });
    assert.equal(out.reason, 'error');
    assert.match(out.detail, /boom/);
  });

  test('a PostHog with no events in the window imports zero days honestly', async () => {
    const h = harness({ range: { ok: true, days: [] } });
    const out = await backfillPosthog(1, { now, deps: h.deps });
    assert.equal(out.ok, true);
    assert.equal(out.imported, 0);
  });
});
