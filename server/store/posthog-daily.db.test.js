import { test, describe, after, before } from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { upsertPosthogDay, getPosthogRange, getPosthogSummary, savePosthogConnection } from './project-posthog.js';

// Real DB (migration 240). The JSONB drop-off aggregation is a lateral recordset expansion that fakes cannot check,
// and the null-vs-zero distinction is enforced by the table itself.

// Days are only written for, and read from, a CONNECTED project, so each fixture site is connected (a pasted key is the
// simplest way to have one). Whether data survives a disconnect or a switch of project is tested in
// project-posthog.oauth.db.test.js.
let savedKey;
before(() => { savedKey = process.env.SECRETS_ENCRYPTION_KEY; process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64'); });

const siteIds = [];
async function makeSite(label) {
  const stamp = `posthog-daily-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('posthog-daily.db.test.js fixture', $1, $2, 'UTC') RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  await savePosthogConnection(rows[0].id, { projectId: '4521', host: 'https://us.posthog.com', apiKey: 'phx_fixture' });
  return rows[0].id;
}
const totals = (over = {}) => ({ events: 1000, people: 100, pageviews: 800, sessions: 200, ...over });

after(async () => {
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY; else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
  if (siteIds.length) {
    await query('DELETE FROM posthog_daily WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

describe('posthog_daily (real DB)', () => {
  test('a day is stored and read back with every metric', async () => {
    const siteId = await makeSite('store');
    await upsertPosthogDay(siteId, { date: '2026-11-04', totals: totals(), dropOffs: [{ event: 'checkout', sessionsEndingHere: 12 }] });
    const [row] = await getPosthogRange(siteId, '2026-11-04', '2026-11-04');
    assert.equal(row.events, 1000);
    assert.equal(row.sessions, 200);
    assert.deepEqual(row.drop_offs, [{ event: 'checkout', sessionsEndingHere: 12 }]);
  });

  test('a metric PostHog did not return is NULL, never 0', async () => {
    const siteId = await makeSite('nulls');
    await upsertPosthogDay(siteId, { date: '2026-11-04', totals: { events: 10, people: null, pageviews: undefined, sessions: '' } });
    const [row] = await getPosthogRange(siteId, '2026-11-04', '2026-11-04');
    assert.equal(row.events, 10);
    assert.equal(row.people, null);
    assert.equal(row.pageviews, null);
    assert.equal(row.sessions, null);
  });

  test('a real zero is kept as zero', async () => {
    const siteId = await makeSite('zero');
    await upsertPosthogDay(siteId, { date: '2026-11-04', totals: totals({ events: 0 }) });
    const [row] = await getPosthogRange(siteId, '2026-11-04', '2026-11-04');
    assert.equal(row.events, 0, 'a measured zero must survive');
  });

  test('a re-fetch replaces the day, because PostHog backfills late events', async () => {
    const siteId = await makeSite('refetch');
    await upsertPosthogDay(siteId, { date: '2026-11-04', totals: totals({ events: 500 }) });
    await upsertPosthogDay(siteId, { date: '2026-11-04', totals: totals({ events: 900 }) });
    const rows = await getPosthogRange(siteId, '2026-11-04', '2026-11-04');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].events, 900);
  });

  test('a re-fetch with no drop-offs does not erase a good earlier result', async () => {
    const siteId = await makeSite('keepdrops');
    await upsertPosthogDay(siteId, { date: '2026-11-04', totals: totals(), dropOffs: [{ event: 'checkout', sessionsEndingHere: 9 }] });
    await upsertPosthogDay(siteId, { date: '2026-11-04', totals: totals({ events: 1200 }), dropOffs: [] });
    const [row] = await getPosthogRange(siteId, '2026-11-04', '2026-11-04');
    assert.equal(row.events, 1200, 'totals still refreshed');
    assert.deepEqual(row.drop_offs, [{ event: 'checkout', sessionsEndingHere: 9 }], 'drop-offs kept');
  });

  test('an impossible metric is refused by the table', async () => {
    const siteId = await makeSite('check');
    await assert.rejects(() => upsertPosthogDay(siteId, { date: '2026-11-04', totals: totals({ events: -5 }) }), /posthog_daily_events_check/);
  });

  test('a range with no data returns no summary — a normal state for an unconnected project', async () => {
    const siteId = await makeSite('nosummary');
    assert.equal(await getPosthogSummary(siteId, '2026-11-01', '2026-11-30'), null);
  });

  test('the summary adds up the period and says how many days it really covers', async () => {
    const siteId = await makeSite('summary');
    await upsertPosthogDay(siteId, { date: '2026-11-01', totals: totals({ events: 100, sessions: 10 }) });
    await upsertPosthogDay(siteId, { date: '2026-11-02', totals: totals({ events: 200, sessions: 20 }) });
    // A day PostHog could not measure: counted as a day, but not as a measured one.
    await upsertPosthogDay(siteId, { date: '2026-11-03', totals: { events: null, sessions: null } });
    const out = await getPosthogSummary(siteId, '2026-11-01', '2026-11-30');
    assert.equal(out.days, 3);
    assert.equal(out.measured_days, 2, 'a partial period must not read as complete');
    assert.equal(out.events, 300);
    assert.equal(out.sessions, 30);
  });

  test('people are reported as the peak day, never summed across days', async () => {
    const siteId = await makeSite('people');
    await upsertPosthogDay(siteId, { date: '2026-11-01', totals: totals({ people: 80 }) });
    await upsertPosthogDay(siteId, { date: '2026-11-02', totals: totals({ people: 150 }) });
    const out = await getPosthogSummary(siteId, '2026-11-01', '2026-11-30');
    assert.equal(out.peak_daily_people, 150, 'summing would double-count a returning person');
    assert.equal(out.people, undefined, 'there is deliberately no summed people figure');
  });

  test('drop-offs are aggregated across the period, worst first', async () => {
    const siteId = await makeSite('drops');
    await upsertPosthogDay(siteId, {
      date: '2026-11-01', totals: totals(),
      dropOffs: [{ event: 'checkout', sessionsEndingHere: 10 }, { event: 'signup', sessionsEndingHere: 4 }],
    });
    await upsertPosthogDay(siteId, {
      date: '2026-11-02', totals: totals(),
      dropOffs: [{ event: 'checkout', sessionsEndingHere: 15 }],
    });
    const out = await getPosthogSummary(siteId, '2026-11-01', '2026-11-30');
    assert.deepEqual(out.topDropOffs, [
      { event: 'checkout', sessions_ending_here: 25 },
      { event: 'signup', sessions_ending_here: 4 },
    ]);
  });

  test('a day with no drop-offs does not break the aggregation', async () => {
    const siteId = await makeSite('emptydrops');
    await upsertPosthogDay(siteId, { date: '2026-11-01', totals: totals(), dropOffs: [] });
    const out = await getPosthogSummary(siteId, '2026-11-01', '2026-11-30');
    assert.deepEqual(out.topDropOffs, []);
  });

  test('data is per site', async () => {
    const a = await makeSite('iso-a');
    const b = await makeSite('iso-b');
    await upsertPosthogDay(a, { date: '2026-11-04', totals: totals({ events: 999 }) });
    assert.deepEqual(await getPosthogRange(b, '2026-11-04', '2026-11-04'), []);
    assert.equal(await getPosthogSummary(b, '2026-11-01', '2026-11-30'), null);
  });

  test('days outside the range are excluded', async () => {
    const siteId = await makeSite('range');
    await upsertPosthogDay(siteId, { date: '2026-10-31', totals: totals({ events: 1 }) });
    await upsertPosthogDay(siteId, { date: '2026-11-01', totals: totals({ events: 2 }) });
    const out = await getPosthogSummary(siteId, '2026-11-01', '2026-11-30');
    assert.equal(out.events, 2);
  });

  test('deleting a site removes its PostHog data', async () => {
    const siteId = await makeSite('cascade');
    await upsertPosthogDay(siteId, { date: '2026-11-04', totals: totals() });
    await query('DELETE FROM sites WHERE id = $1', [siteId]);
    const { rows } = await query('SELECT count(*)::int AS n FROM posthog_daily WHERE site_id = $1', [siteId]);
    assert.equal(rows[0].n, 0);
  });

  // ── migration 244: top actions + the per-day series ──────────────────────

  const act = (label, times, raw = null) => ({ label, raw, times });

  test('a day\'s actions are stored and read back', async () => {
    const siteId = await makeSite('actions-store');
    await upsertPosthogDay(siteId, { date: '2026-11-04', totals: totals(), topActions: [act('Booking form started', 31, 'booking_form_started'), act('Clicked \u201cBook now\u201d', 55)] });
    const [row] = await getPosthogRange(siteId, '2026-11-04', '2026-11-04');
    assert.deepEqual(row.top_actions, [act('Booking form started', 31, 'booking_form_started'), act('Clicked \u201cBook now\u201d', 55)]);
  });

  test('a re-fetch with no actions does not erase a good earlier result, but a new one replaces it', async () => {
    const siteId = await makeSite('actions-keep');
    await upsertPosthogDay(siteId, { date: '2026-11-04', totals: totals(), topActions: [act('Faq opened', 5, 'faq_opened')] });
    await upsertPosthogDay(siteId, { date: '2026-11-04', totals: totals({ events: 1100 }), topActions: [] });
    assert.deepEqual((await getPosthogRange(siteId, '2026-11-04', '2026-11-04'))[0].top_actions, [act('Faq opened', 5, 'faq_opened')]);
    await upsertPosthogDay(siteId, { date: '2026-11-04', totals: totals(), topActions: [act('Faq opened', 9, 'faq_opened')] });
    assert.equal((await getPosthogRange(siteId, '2026-11-04', '2026-11-04'))[0].top_actions[0].times, 9);
  });

  test('actions are added up by label across the period, biggest first, and a day with none does not break it', async () => {
    const siteId = await makeSite('actions-sum');
    await upsertPosthogDay(siteId, { date: '2026-11-01', totals: totals(), topActions: [act('Clicked \u201cBook now\u201d', 10), act('Faq opened', 4, 'faq_opened')] });
    await upsertPosthogDay(siteId, { date: '2026-11-02', totals: totals(), topActions: [act('Clicked \u201cBook now\u201d', 7), act('Played the intro video', 20, 'intro_video_played')] });
    await upsertPosthogDay(siteId, { date: '2026-11-03', totals: totals() });
    const s = await getPosthogSummary(siteId, '2026-11-01', '2026-11-03');
    assert.deepEqual(s.topActions, [
      act('Played the intro video', 20, 'intro_video_played'), act('Clicked \u201cBook now\u201d', 17), act('Faq opened', 4, 'faq_opened'),
    ]);
  });

  test('the per-day series has one point per stored day, null where PostHog returned nothing, and people is each day\'s own count', async () => {
    const siteId = await makeSite('series');
    await upsertPosthogDay(siteId, { date: '2026-11-01', totals: totals({ people: 40, pageviews: 90, sessions: 50, events: 300 }) });
    await upsertPosthogDay(siteId, { date: '2026-11-03', totals: { events: 10, people: null, pageviews: null, sessions: null } });
    const s = await getPosthogSummary(siteId, '2026-11-01', '2026-11-05');
    assert.deepEqual(s.series, [
      { date: '2026-11-01', pageviews: 90, sessions: 50, events: 300, people: 40 },
      { date: '2026-11-03', pageviews: null, sessions: null, events: 10, people: null },
    ]);
    assert.equal(s.days, 2, 'a day with no row is absent, not zero');
  });

  test('the previous period is the same call on another range, and the two never mix', async () => {
    const siteId = await makeSite('previous');
    for (const [d, pv] of [['2026-10-01', 100], ['2026-10-02', 100], ['2026-11-01', 300], ['2026-11-02', 300]]) {
      await upsertPosthogDay(siteId, { date: d, totals: totals({ pageviews: pv }), topActions: [act('Clicked \u201cBook now\u201d', pv / 10)] });
    }
    const cur = await getPosthogSummary(siteId, '2026-11-01', '2026-11-02');
    const prev = await getPosthogSummary(siteId, '2026-10-01', '2026-10-02');
    assert.equal(cur.pageviews, 600); assert.equal(prev.pageviews, 200);
    assert.equal(cur.topActions[0].times, 60); assert.equal(prev.topActions[0].times, 20);
    assert.deepEqual(cur.series.map((p) => p.date), ['2026-11-01', '2026-11-02']);
    assert.equal(await getPosthogSummary(siteId, '2026-09-01', '2026-09-30'), null, 'a period with no data is null');
  });
});
