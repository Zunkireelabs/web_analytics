import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runPosthogIngestForAllSites } from './job.js';

// The properties that matter: a platform where nobody connected PostHog does nothing; one client's revoked key marks
// THAT client and never aborts the loop; and a drop-off failure must not cost the day's totals, which already worked.

const site = (over = {}) => ({ id: 1, name: 'Client', timezone: 'UTC', ...over });
const metrics = { ok: true, totals: { events: 5000, people: 420, pageviews: 3100, sessions: 610 } };

function harness({ sites = [site()], day = metrics, drops = { ok: true, dropOffs: [{ event: 'checkout', sessionsEndingHere: 12 }] }, actions = { ok: true, topActions: [{ label: 'Booking form started', raw: 'booking_form_started', times: 7 }] }, credentials = { projectId: '1', apiKey: 'k', host: 'https://us.posthog.com' } } = {}) {
  const calls = { saved: [], status: [], days: [], drops: [], actions: [] };
  return {
    calls,
    deps: {
      listSitesFn: async () => sites,
      credentialsFor: async () => credentials,
      fetchDay: async (creds, date) => { calls.days.push(date); return typeof day === 'function' ? day(date) : day; },
      fetchDrops: async (creds, date) => { calls.drops.push(date); return typeof drops === 'function' ? drops(date) : drops; },
      fetchActions: async (creds, date) => { calls.actions.push(date); return typeof actions === 'function' ? actions(date) : actions; },
      saveDay: async (siteId, row) => { calls.saved.push({ siteId, ...row }); },
      recordStatus: async (siteId, ok, detail) => { calls.status.push({ siteId, ok, detail }); },
    },
  };
}

describe('nothing connected means nothing done', () => {
  test('no connected site does no work at all', async () => {
    const h = harness({ sites: [] });
    const totals = await runPosthogIngestForAllSites(h.deps);
    assert.deepEqual(totals, { sites: 0, ingested: 0, failed: 0 });
    assert.equal(h.calls.days.length, 0);
  });

  test('a site that disconnected between listing and fetching is skipped, not crashed on', async () => {
    const h = harness({ credentials: null });
    const totals = await runPosthogIngestForAllSites(h.deps);
    assert.equal(totals.failed, 1);
    assert.equal(h.calls.days.length, 0);
    assert.equal(h.calls.saved.length, 0);
  });
});

describe('a successful day', () => {
  test('totals and drop-offs are stored, and the connection marked healthy', async () => {
    const h = harness();
    const totals = await runPosthogIngestForAllSites(h.deps);
    assert.equal(totals.ingested, 1);
    assert.deepEqual(h.calls.saved[0].totals, metrics.totals);
    assert.deepEqual(h.calls.saved[0].dropOffs, [{ event: 'checkout', sessionsEndingHere: 12 }]);
    assert.deepEqual(h.calls.status, [{ siteId: 1, ok: true, detail: undefined }]);
  });

  test('yesterday is fetched, not today, so a partial day is never stored as final', async () => {
    const h = harness();
    await runPosthogIngestForAllSites({ ...h.deps, now: new Date('2026-11-05T12:00:00Z') });
    assert.deepEqual(h.calls.days, ['2026-11-04']);
  });

  test("each site's own timezone decides its date", async () => {
    const h = harness({ sites: [site({ id: 1, timezone: 'UTC' }), site({ id: 2, timezone: 'Pacific/Kiritimati' })] });
    await runPosthogIngestForAllSites({ ...h.deps, now: new Date('2026-11-05T12:00:00Z') });
    assert.deepEqual(h.calls.days, ['2026-11-04', '2026-11-05'], 'a +14 timezone is already on the next day');
  });
});

describe('failures stay with the client that caused them', () => {
  test('a revoked key marks that connection and does not throw', async () => {
    const h = harness({ day: { ok: false, reason: 'unauthorized', detail: 'PostHog rejected the API key' } });
    const totals = await runPosthogIngestForAllSites(h.deps);
    assert.equal(totals.failed, 1);
    assert.equal(totals.ingested, 0);
    assert.deepEqual(h.calls.status, [{ siteId: 1, ok: false, detail: 'PostHog rejected the API key' }]);
    assert.equal(h.calls.saved.length, 0, 'nothing is stored for a failed fetch');
  });

  test('one failing client does not stop the others', async () => {
    const h = harness({
      sites: [site({ id: 1 }), site({ id: 2 })],
      day: () => ({ ok: true, totals: metrics.totals }),
    });
    h.deps.fetchDay = async (creds, date) => {
      // The first site's instance is down; the second is fine.
      if (h.calls.days.push(date) === 1) return { ok: false, reason: 'unreachable', detail: 'ETIMEDOUT' };
      return metrics;
    };
    const totals = await runPosthogIngestForAllSites(h.deps);
    assert.equal(totals.sites, 2);
    assert.equal(totals.ingested, 1);
    assert.equal(totals.failed, 1);
  });

  test('an unexpected exception for one client is caught and counted', async () => {
    const h = harness();
    h.deps.fetchDay = async () => { throw new Error('boom'); };
    const totals = await runPosthogIngestForAllSites(h.deps);
    assert.equal(totals.failed, 1);
  });

  test('a drop-off failure does not cost the day\'s totals', async () => {
    const h = harness({ drops: { ok: false, reason: 'failed' } });
    const totals = await runPosthogIngestForAllSites(h.deps);
    assert.equal(totals.ingested, 1);
    assert.deepEqual(h.calls.saved[0].totals, metrics.totals);
    assert.deepEqual(h.calls.saved[0].dropOffs, [], 'none stored, so an earlier good result for the day survives');
    assert.deepEqual(h.calls.status, [{ siteId: 1, ok: true, detail: undefined }]);
  });

  test('a drop-off query that throws is treated the same way', async () => {
    const h = harness();
    h.deps.fetchDrops = async () => { throw new Error('hogql error'); };
    const totals = await runPosthogIngestForAllSites(h.deps);
    assert.equal(totals.ingested, 1);
    assert.deepEqual(h.calls.saved[0].dropOffs, []);
  });

  test('the day\'s clicks and form steps are saved with it', async () => {
    const h = harness();
    await runPosthogIngestForAllSites(h.deps);
    assert.deepEqual(h.calls.saved[0].topActions, [{ label: 'Booking form started', raw: 'booking_form_started', times: 7 }]);
  });

  test('an actions failure (returned or thrown) does not cost the totals or the drop-offs', async () => {
    for (const actions of [{ ok: false, reason: 'failed' }, async () => { throw new Error('hogql error'); }]) {
      const h = harness({ actions });
      const totals = await runPosthogIngestForAllSites(h.deps);
      assert.equal(totals.ingested, 1);
      assert.deepEqual(h.calls.saved[0].totals, metrics.totals);
      assert.equal(h.calls.saved[0].dropOffs.length, 1);
      assert.deepEqual(h.calls.saved[0].topActions, [], 'none stored, so an earlier good result for the day survives');
    }
  });

  test('a sign-in that could not be refreshed marks THAT connection with the real reason and never throws', async () => {
    const h = harness({
      credentials: { projectId: '1', host: 'https://us.posthog.com', apiKey: null, authError: { reason: 'unauthorized', detail: 'PostHog access was revoked or has expired.' } },
      day: async () => ({ ok: false, reason: 'unauthorized', detail: 'PostHog access was revoked or has expired.' }),
    });
    const totals = await runPosthogIngestForAllSites(h.deps);
    assert.equal(totals.failed, 1);
    assert.deepEqual(h.calls.status, [{ siteId: 1, ok: false, detail: 'PostHog access was revoked or has expired.' }]);
    assert.equal(h.calls.saved.length, 0);
  });

  // One bad night must not switch the connection off forever: an 'error' status removes the site from tomorrow's run.
  test('a TRANSIENT failure (timeout, HTTP 5xx, rate limit) leaves the status alone so tomorrow retries it', async () => {
    for (const reason of ['unreachable', 'failed']) {
      const h = harness({ day: { ok: false, reason, detail: 'ETIMEDOUT' } });
      const totals = await runPosthogIngestForAllSites(h.deps);
      assert.equal(totals.failed, 1, reason);
      assert.deepEqual(h.calls.status, [], `${reason} must not be recorded on the connection`);
      assert.equal(h.calls.saved.length, 0);
    }
  });

  test('a failure about the CONNECTION itself (refused key or grant, project gone, unusable address) marks it', async () => {
    for (const reason of ['unauthorized', 'project_not_found', 'bad_host']) {
      const h = harness({ day: { ok: false, reason, detail: `because ${reason}` } });
      await runPosthogIngestForAllSites(h.deps);
      assert.deepEqual(h.calls.status, [{ siteId: 1, ok: false, detail: `because ${reason}` }], reason);
    }
  });

  test('a transient failure for one client still lets the rest of the loop run', async () => {
    const h = harness({ sites: [site({ id: 1 }), site({ id: 2 })], day: (date) => (h.calls.days.length === 1 ? { ok: false, reason: 'unreachable', detail: 'x' } : metrics) });
    const totals = await runPosthogIngestForAllSites(h.deps);
    assert.deepEqual([totals.ingested, totals.failed], [1, 1]);
    assert.deepEqual(h.calls.status, [{ siteId: 2, ok: true, detail: undefined }]);
  });
});
