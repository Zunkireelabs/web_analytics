import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../../db.js';
import { insertRecommendation } from '../../store/recommendations.js';
import { getGeneratorTrackRecord } from '../../store/analyst-evidence.js';

// Real database: a client's track record is built from ITS OWN measured fixes only. Two sites, the same generator, opposite histories.
const sites = {};

async function addSite(label) {
  const stamp = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, website_domain) VALUES ('analyst-track-record.db.test.js fixture', $1, $2, 'UTC', $3) RETURNING *`,
    [stamp, stamp, `${label}.track-record-test.example`]);
  return rows[0];
}

// One measured outcome for `generator` on `site`. improved: true | false | null (no readable direction).
async function measured(site, generator, n, improved) {
  const page = `https://${site.website_domain}/p${n}`;
  const rec = await insertRecommendation(site.id, { page, recommendationType: generator, issue: 'x', reason: 'x', params: { page }, findingId: `t:${generator}:${n}`, detectingAgent: 'analyst-fusion', priority: 'medium', riskTier: 'safe' });
  await query(
    `INSERT INTO analyst_evidence (site_id, subject_type, subject_key, direction, verdict, corroboration, recommendation_id, outcome, measured_at)
     VALUES ($1, 'page', $2, 'decline-risk', 'act', 2, $3, $4, now())`,
    [site.id, page, rec.id, JSON.stringify({ improved, delta: { clicks: improved ? 5 : -5 } })]);
}

before(async () => { sites.good = await addSite('good'); sites.bad = await addSite('bad'); });
after(async () => {
  for (const s of Object.values(sites)) {
    await query('DELETE FROM analyst_evidence WHERE site_id = $1', [s.id]);
    await query('DELETE FROM recommendations WHERE site_id = $1', [s.id]);
    await query('DELETE FROM sites WHERE id = $1', [s.id]);
  }
  await pool.end();
});

describe('getGeneratorTrackRecord', () => {
  test('counts only this site, per generator, and leaves out outcomes with no readable direction', async () => {
    for (let i = 0; i < 6; i++) await measured(sites.good, 'meta-title', i, true);      // good site: meta-title always worked
    for (let i = 0; i < 6; i++) await measured(sites.bad, 'meta-title', i, i === 0);    // bad site: it worked 1 time in 6
    await measured(sites.good, 'meta-title', 99, null);                                  // unknown direction: not a miss, not counted
    await measured(sites.good, 'expand-content', 0, false);

    const good = Object.fromEntries((await getGeneratorTrackRecord(sites.good.id)).map((r) => [r.generator_id, r]));
    const bad = Object.fromEntries((await getGeneratorTrackRecord(sites.bad.id)).map((r) => [r.generator_id, r]));
    assert.deepEqual([good['meta-title'].measured, good['meta-title'].improved], [6, 6]);
    assert.deepEqual([good['expand-content'].measured, good['expand-content'].improved], [1, 0]);
    assert.deepEqual([bad['meta-title'].measured, bad['meta-title'].improved], [6, 1], 'the other client\'s successes never lift this one');
    assert.equal(bad['expand-content'], undefined);
  });

  test('a site with no measured fixes has an empty record', async () => {
    const empty = await addSite('empty');
    try { assert.deepEqual(await getGeneratorTrackRecord(empty.id), []); }
    finally { await query('DELETE FROM sites WHERE id = $1', [empty.id]); }
  });
});
