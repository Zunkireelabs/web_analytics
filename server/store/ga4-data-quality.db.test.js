import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { getGa4DataQuality } from './read.js';
import { upsertGa4 } from './upsert.js';

// Real DB (migration 238). The rule under test: a range is only ever described as clean when every day in it was
// assessed AND came back clean. A day we never assessed must not be counted as complete, and one bad day must not be
// hidden inside a good week.

const siteIds = [];
async function makeSite(label) {
  const stamp = `ga4-quality-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('ga4-data-quality.db.test.js fixture', $1, $2, 'UTC') RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}
const totals = { users: 10, new_users: 5, sessions: 12, engaged_sessions: 8, avg_engagement_time: 30, conversions: 1, bounce_rate: 0.4 };
const day = (siteId, date, dataQuality) => upsertGa4(siteId, { date, totals, channels: [], dataQuality });

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM ga4_daily WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

describe('GA4 data quality (real DB)', () => {
  test('a clean period reports complete, with nothing to say', async () => {
    const siteId = await makeSite('clean');
    await day(siteId, '2026-10-01', { confidence: 'complete', flags: {}, notes: [] });
    await day(siteId, '2026-10-02', { confidence: 'complete', flags: {}, notes: [] });
    const out = await getGa4DataQuality(siteId, '2026-10-01', '2026-10-02');
    assert.equal(out.worst, 'complete');
    assert.deepEqual(out.notes, []);
    assert.deepEqual(out.affectedDays, []);
  });

  test('one withheld day makes the whole period partial', async () => {
    const siteId = await makeSite('partial');
    await day(siteId, '2026-10-01', { confidence: 'complete', notes: [] });
    await day(siteId, '2026-10-02', { confidence: 'partial', flags: { thresholded: true }, notes: ['Google withheld some rows for this day.'] });
    const out = await getGa4DataQuality(siteId, '2026-10-01', '2026-10-02');
    assert.equal(out.worst, 'partial');
    assert.equal(out.affectedDays.length, 1);
    assert.equal(out.notes.length, 1);
    assert.match(out.notes[0], /withheld some rows on 1 day/);
  });

  test('sampling outranks withholding — the worst verdict wins', async () => {
    const siteId = await makeSite('worst');
    await day(siteId, '2026-10-01', { confidence: 'partial', notes: ['withheld'] });
    await day(siteId, '2026-10-02', { confidence: 'estimated', notes: ['sampled'] });
    const out = await getGa4DataQuality(siteId, '2026-10-01', '2026-10-02');
    assert.equal(out.worst, 'estimated');
    assert.equal(out.counts.partial, 1);
    assert.equal(out.counts.estimated, 1);
  });

  test('the same cause repeated across many days is told once', async () => {
    const siteId = await makeSite('dedupe');
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      await day(siteId, d, { confidence: 'partial', flags: { thresholded: true }, notes: ['Google withheld some rows for this day.'] });
    }
    const out = await getGa4DataQuality(siteId, '2026-10-01', '2026-10-03');
    assert.equal(out.notes.length, 1);
    assert.match(out.notes[0], /on 3 days/, 'the count of days is in the one sentence');
    assert.equal(out.affectedDays.length, 3);
  });

  test('the same breakdown at DIFFERENT percentages is still one sentence, not one per number', async () => {
    // The real regression: each day's own note embeds its own percentage, so de-duplicating the note TEXT left
    // "city accounts for 93%" and "city accounts for 73%" side by side as if they were two different problems.
    const siteId = await makeSite('percentages');
    const incomplete = (missingShare) => ({
      confidence: 'partial',
      flags: { incompleteBreakdowns: [{ dimension: 'city', missingShare }] },
      notes: [`The city breakdown accounts for ${Math.round((1 - missingShare) * 100)}% of the day's total; the rest was not returned by Google.`],
    });
    await day(siteId, '2026-10-01', incomplete(0.07));
    await day(siteId, '2026-10-02', incomplete(0.27));
    await day(siteId, '2026-10-03', incomplete(0.15));
    const out = await getGa4DataQuality(siteId, '2026-10-01', '2026-10-03');
    assert.equal(out.notes.length, 1, JSON.stringify(out.notes));
    assert.match(out.notes[0], /city breakdown was incomplete on 3 days/);
    assert.match(out.notes[0], /as little as 73%/, 'the worst day is the number reported');
  });

  test('different dimensions stay separate, worst first', async () => {
    const siteId = await makeSite('dimensions');
    await day(siteId, '2026-10-01', { confidence: 'partial', flags: { incompleteBreakdowns: [{ dimension: 'city', missingShare: 0.1 }, { dimension: 'country', missingShare: 0.4 }] }, notes: [] });
    const out = await getGa4DataQuality(siteId, '2026-10-01', '2026-10-01');
    assert.equal(out.notes.length, 2);
    assert.match(out.notes[0], /country/, 'the worse breakdown leads');
    assert.match(out.notes[1], /city/);
  });

  test('sampled days report the lowest sampling share seen', async () => {
    const siteId = await makeSite('sampled');
    await day(siteId, '2026-10-01', { confidence: 'estimated', flags: { sampled: true }, samplingRatio: 0.6, notes: [] });
    await day(siteId, '2026-10-02', { confidence: 'estimated', flags: { sampled: true }, samplingRatio: 0.3, notes: [] });
    const out = await getGa4DataQuality(siteId, '2026-10-01', '2026-10-02');
    assert.equal(out.notes.length, 1);
    assert.match(out.notes[0], /sampled data on 2 days/);
    assert.match(out.notes[0], /as little as 30%/);
  });

  test('a day ingested before this existed is unassessed, never counted as clean', async () => {
    const siteId = await makeSite('unassessed');
    await day(siteId, '2026-10-01', null);
    const out = await getGa4DataQuality(siteId, '2026-10-01', '2026-10-01');
    assert.equal(out.worst, null, 'nothing assessed means no verdict, not "complete"');
    assert.equal(out.unassessed, 1);
  });

  test('an unassessed day alongside a clean one is reported separately', async () => {
    const siteId = await makeSite('mixed');
    await day(siteId, '2026-10-01', null);
    await day(siteId, '2026-10-02', { confidence: 'complete', notes: [] });
    const out = await getGa4DataQuality(siteId, '2026-10-01', '2026-10-02');
    assert.equal(out.worst, 'complete');
    assert.equal(out.unassessed, 1);
    assert.equal(out.days, 2);
  });

  test('a re-ingest that computes no verdict does not erase the stored one', async () => {
    const siteId = await makeSite('noerase');
    await day(siteId, '2026-10-01', { confidence: 'estimated', notes: ['sampled'] });
    await day(siteId, '2026-10-01', null); // e.g. an older code path, or a partial backfill
    const out = await getGa4DataQuality(siteId, '2026-10-01', '2026-10-01');
    assert.equal(out.worst, 'estimated');
  });

  test('a re-ingest with a fresh verdict replaces the old one', async () => {
    const siteId = await makeSite('replace');
    await day(siteId, '2026-10-01', { confidence: 'estimated', notes: ['sampled'] });
    await day(siteId, '2026-10-01', { confidence: 'complete', notes: [] });
    const out = await getGa4DataQuality(siteId, '2026-10-01', '2026-10-01');
    assert.equal(out.worst, 'complete');
  });

  test('a range with no data at all says so rather than claiming cleanliness', async () => {
    const siteId = await makeSite('empty');
    const out = await getGa4DataQuality(siteId, '2026-10-01', '2026-10-07');
    assert.equal(out.worst, null);
    assert.equal(out.days, 0);
  });

  test('quality is per site', async () => {
    const a = await makeSite('iso-a');
    const b = await makeSite('iso-b');
    await day(a, '2026-10-01', { confidence: 'estimated', notes: ['sampled'] });
    await day(b, '2026-10-01', { confidence: 'complete', notes: [] });
    assert.equal((await getGa4DataQuality(b, '2026-10-01', '2026-10-01')).worst, 'complete');
  });

  test('an invalid verdict is refused by the table rather than stored', async () => {
    const siteId = await makeSite('check');
    await assert.rejects(() => day(siteId, '2026-10-01', { confidence: 'probably-fine', notes: [] }), /data_confidence_check/);
  });

  test('days outside the range are not counted', async () => {
    const siteId = await makeSite('range');
    await day(siteId, '2026-09-30', { confidence: 'estimated', notes: ['sampled'] });
    await day(siteId, '2026-10-01', { confidence: 'complete', notes: [] });
    const out = await getGa4DataQuality(siteId, '2026-10-01', '2026-10-31');
    assert.equal(out.worst, 'complete');
    assert.equal(out.days, 1);
  });
});
