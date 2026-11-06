import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import {
  saveCompetitorKeywords, saveCompetitorPages, recordFootprintRun, listCompetitorsNeedingFootprint,
  getLatestFootprint, getAllLatestFootprints, getFootprintChange, getNewlyGainedKeywords,
} from './competitor-footprint.js';
import { upsertCompetitorClassification } from './competitor-profiles.js';

// Real DB (migration 233). The multi-row INSERT's parameter numbering, the snapshot/latest selection, the freshness
// query's join and the two-snapshot delta are all real SQL that fakes cannot check. Two sites share a competitor on
// purpose: a query that forgot site_id would mix two projects' paid research and fail here.

const siteIds = [];
async function makeSite(label) {
  const stamp = `competitor-footprint-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('competitor-footprint.db.test.js fixture', $1, $2, 'UTC') RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}
const kw = (keyword, over = {}) => ({
  keyword, locationCode: 2524, languageCode: 'en', position: 5, rankingUrl: `https://rival.com/${keyword.replace(/\s+/g, '-')}`,
  searchVolume: 100, keywordDifficulty: 30, cpc: 1.25, searchIntent: 'commercial', estimatedTraffic: 12.5, ...over,
});

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM competitor_keyword_snapshots WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM competitor_page_snapshots WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM competitor_footprint_runs WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM competitor_profiles WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

describe('competitor footprint (real DB)', () => {
  test('stores a multi-row snapshot and reads every metric back unchanged', async () => {
    const siteId = await makeSite('store');
    const stored = await saveCompetitorKeywords(siteId, 'rival.com', [kw('teeth whitening'), kw('dental implants', { position: 2, searchVolume: 500 })]);
    assert.equal(stored, 2);
    const rows = await getLatestFootprint(siteId, 'rival.com');
    assert.deepEqual(rows.map((r) => r.keyword), ['dental implants', 'teeth whitening']);
    const first = rows[0];
    assert.equal(first.position, 2);
    assert.equal(first.search_volume, 500);
    assert.equal(first.cpc, 1.25);
    assert.equal(first.search_intent, 'commercial');
    assert.equal(first.estimated_traffic, 12.5);
  });

  test('a metric the provider omitted is stored as NULL, never as zero', async () => {
    const siteId = await makeSite('nulls');
    await saveCompetitorKeywords(siteId, 'rival.com', [{ keyword: 'bare', locationCode: 2524 }]);
    const [row] = await getLatestFootprint(siteId, 'rival.com');
    assert.equal(row.search_volume, null);
    assert.equal(row.keyword_difficulty, null);
    assert.equal(row.position, null);
    assert.equal(row.cpc, null);
  });

  test('storing nothing is not an error and writes nothing', async () => {
    const siteId = await makeSite('empty');
    assert.equal(await saveCompetitorKeywords(siteId, 'rival.com', []), 0);
    assert.deepEqual(await getLatestFootprint(siteId, 'rival.com'), []);
  });

  test('a second snapshot does not overwrite the first, and only the latest is read', async () => {
    const siteId = await makeSite('snapshots');
    const older = new Date(Date.now() - 86400000);
    await saveCompetitorKeywords(siteId, 'rival.com', [kw('old keyword')], { capturedAt: older });
    await saveCompetitorKeywords(siteId, 'rival.com', [kw('new keyword')]);
    assert.deepEqual((await getLatestFootprint(siteId, 'rival.com')).map((r) => r.keyword), ['new keyword']);
    const { rows } = await query('SELECT count(*)::int AS n FROM competitor_keyword_snapshots WHERE site_id = $1', [siteId]);
    assert.equal(rows[0].n, 2);
  });

  test('re-storing the same keyword in the same snapshot is ignored rather than duplicated', async () => {
    const siteId = await makeSite('dedupe');
    const capturedAt = new Date();
    await saveCompetitorKeywords(siteId, 'rival.com', [kw('same')], { capturedAt });
    await saveCompetitorKeywords(siteId, 'rival.com', [kw('same')], { capturedAt });
    const { rows } = await query('SELECT count(*)::int AS n FROM competitor_keyword_snapshots WHERE site_id = $1', [siteId]);
    assert.equal(rows[0].n, 1);
  });

  test('footprints are per site: one project cannot read another\'s paid research', async () => {
    const a = await makeSite('iso-a');
    const b = await makeSite('iso-b');
    await saveCompetitorKeywords(a, 'shared.com', [kw('a only')]);
    await saveCompetitorKeywords(b, 'shared.com', [kw('b only')]);
    assert.deepEqual((await getLatestFootprint(a, 'shared.com')).map((r) => r.keyword), ['a only']);
    assert.deepEqual((await getLatestFootprint(b, 'shared.com')).map((r) => r.keyword), ['b only']);
  });

  test('pages store their top keywords as JSON', async () => {
    const siteId = await makeSite('pages');
    const n = await saveCompetitorPages(siteId, 'rival.com', [
      { url: 'https://rival.com/whitening', estimatedTraffic: 300, keywordCount: 24, topKeywords: ['teeth whitening', 'whitening cost'] },
    ], { locationCode: 2524 });
    assert.equal(n, 1);
    const { rows } = await query('SELECT url, estimated_traffic::float AS t, keyword_count, top_keywords FROM competitor_page_snapshots WHERE site_id = $1', [siteId]);
    assert.equal(rows[0].t, 300);
    assert.deepEqual(rows[0].top_keywords, ['teeth whitening', 'whitening cost']);
  });

  test('only business competitors are due, and freshness is respected', async () => {
    const siteId = await makeSite('due');
    await upsertCompetitorClassification(siteId, 'rival.com', { kind: 'business', relevanceScore: 0.9 });
    await upsertCompetitorClassification(siteId, 'directory.com', { kind: 'organic', relevanceScore: 0.1 });
    await upsertCompetitorClassification(siteId, 'facebook.com', { kind: null, excludedReason: 'platform' });
    assert.deepEqual((await listCompetitorsNeedingFootprint(siteId)).map((r) => r.domain), ['rival.com']);

    await recordFootprintRun(siteId, 'rival.com', { status: 'ok', keywordsStored: 10 });
    assert.deepEqual(await listCompetitorsNeedingFootprint(siteId), []);

    // Collected long ago: due again.
    await recordFootprintRun(siteId, 'rival.com', { status: 'ok', keywordsStored: 10, collectedAt: new Date(Date.now() - 40 * 86400000) });
    assert.deepEqual((await listCompetitorsNeedingFootprint(siteId, { maxAgeDays: 30 })).map((r) => r.domain), ['rival.com']);
  });

  test('a failed or partial previous run is due again immediately', async () => {
    const siteId = await makeSite('retry');
    await upsertCompetitorClassification(siteId, 'rival.com', { kind: 'business', relevanceScore: 0.5 });
    for (const status of ['failed', 'partial', 'budget_refused']) {
      await recordFootprintRun(siteId, 'rival.com', { status });
      assert.deepEqual((await listCompetitorsNeedingFootprint(siteId)).map((r) => r.domain), ['rival.com'], `status ${status} should be retried`);
    }
  });

  test('due competitors come back strongest-evidence-first', async () => {
    const siteId = await makeSite('order');
    await upsertCompetitorClassification(siteId, 'weak.com', { kind: 'business', relevanceScore: 0.2 });
    await upsertCompetitorClassification(siteId, 'strong.com', { kind: 'business', relevanceScore: 0.9 });
    assert.deepEqual((await listCompetitorsNeedingFootprint(siteId)).map((r) => r.domain), ['strong.com', 'weak.com']);
  });

  test('the combined read covers every business competitor and drops reclassified ones', async () => {
    const siteId = await makeSite('combined');
    await upsertCompetitorClassification(siteId, 'a.com', { kind: 'business', relevanceScore: 0.8 });
    await upsertCompetitorClassification(siteId, 'b.com', { kind: 'business', relevanceScore: 0.7 });
    await saveCompetitorKeywords(siteId, 'a.com', [kw('from a')]);
    await saveCompetitorKeywords(siteId, 'b.com', [kw('from b')]);
    assert.equal((await getAllLatestFootprints(siteId)).length, 2);

    // Reclassified as a directory: its keywords must stop driving work, without deleting what was paid for.
    await upsertCompetitorClassification(siteId, 'b.com', { kind: 'organic', relevanceScore: 0 });
    assert.deepEqual((await getAllLatestFootprints(siteId)).map((r) => r.competitor_domain), ['a.com']);
    const { rows } = await query('SELECT count(*)::int AS n FROM competitor_keyword_snapshots WHERE site_id = $1', [siteId]);
    assert.equal(rows[0].n, 2);
  });

  test('one snapshot means no comparison, which is not the same as no change', async () => {
    const siteId = await makeSite('nochange');
    await saveCompetitorKeywords(siteId, 'rival.com', [kw('only one')]);
    assert.equal(await getFootprintChange(siteId, 'rival.com'), null);
  });

  test('two snapshots give gained, lost, improved and declined counts', async () => {
    const siteId = await makeSite('delta');
    const older = new Date(Date.now() - 86400000);
    await saveCompetitorKeywords(siteId, 'rival.com', [kw('kept', { position: 9 }), kw('dropped'), kw('worse', { position: 4 })], { capturedAt: older });
    await saveCompetitorKeywords(siteId, 'rival.com', [kw('kept', { position: 3 }), kw('gained'), kw('worse', { position: 20 })]);
    const change = await getFootprintChange(siteId, 'rival.com');
    assert.equal(change.gained, 1);
    assert.equal(change.lost, 1);
    assert.equal(change.improved, 1);
    assert.equal(change.declined, 1);
  });

  test('newly gained keywords are the emerging-topic signal, and need two snapshots', async () => {
    const siteId = await makeSite('gained');
    await saveCompetitorKeywords(siteId, 'rival.com', [kw('first only')]);
    assert.deepEqual(await getNewlyGainedKeywords(siteId, 'rival.com'), []);
    await saveCompetitorKeywords(siteId, 'rival.com', [kw('first only'), kw('brand new', { searchVolume: 900 })]);
    assert.deepEqual((await getNewlyGainedKeywords(siteId, 'rival.com')).map((r) => r.keyword), ['brand new']);
  });

  test('the table refuses impossible measurements rather than storing them', async () => {
    const siteId = await makeSite('checks');
    await assert.rejects(() => saveCompetitorKeywords(siteId, 'r.com', [kw('bad', { position: 0 })]), /position/);
    await assert.rejects(() => saveCompetitorKeywords(siteId, 'r.com', [kw('bad', { keywordDifficulty: 150 })]), /keyword_difficulty/);
    await assert.rejects(() => saveCompetitorKeywords(siteId, 'r.com', [kw('bad', { searchIntent: 'shopping' })]), /search_intent/);
    await assert.rejects(() => recordFootprintRun(siteId, 'r.com', { status: 'maybe' }), /status/);
  });

  test('deleting a site removes every footprint row it paid for', async () => {
    const siteId = await makeSite('cascade');
    await saveCompetitorKeywords(siteId, 'rival.com', [kw('x')]);
    await saveCompetitorPages(siteId, 'rival.com', [{ url: 'https://rival.com/a' }], { locationCode: 2524 });
    await recordFootprintRun(siteId, 'rival.com', { status: 'ok' });
    await query('DELETE FROM sites WHERE id = $1', [siteId]);
    for (const table of ['competitor_keyword_snapshots', 'competitor_page_snapshots', 'competitor_footprint_runs']) {
      const { rows } = await query(`SELECT count(*)::int AS n FROM ${table} WHERE site_id = $1`, [siteId]);
      assert.equal(rows[0].n, 0, `${table} should be empty`);
    }
  });
});
