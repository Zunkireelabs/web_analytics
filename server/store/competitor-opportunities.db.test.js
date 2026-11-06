import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import {
  saveCompetitorOpportunities, listCompetitorOpportunities, advanceOpportunityLifecycle,
  recordOpportunityOutcome, getLearnedMultipliers, MIN_VERIFIED,
} from './competitor-opportunities.js';

// Real DB (migration 234). The things only real SQL can check: the partial-unique ON CONFLICT path, the
// accepted/dismissed guard, the xmax inserted-vs-updated detection, the forward-only lifecycle, and the site_id
// filter. Two sites are planted so a query that forgot site_id would move another project's work and fail here.

const siteIds = [];
async function makeSite(label) {
  const stamp = `competitor-opps-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('competitor-opportunities.db.test.js fixture', $1, $2, 'UTC') RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}
const opp = (keyword, over = {}) => ({
  keyword, reason: 'rivals rank for this', score: 0.72, opportunityType: 'missing',
  searchVolume: 400, keywordDifficulty: 30, searchIntent: 'commercial',
  ourPosition: null, bestCompetitorPosition: 3, existingPageMatch: null, contentPlan: 'blog',
  locationCode: 2524, languageCode: 'en', evidence: { competitors: [{ domain: 'rival.com', position: 3 }] },
  ...over,
});

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM keyword_gaps WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM opportunity_type_outcomes WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

describe('competitor opportunities in the existing queue (real DB)', () => {
  test('an opportunity lands in keyword_gaps with its evidence and is readable back', async () => {
    const siteId = await makeSite('store');
    const res = await saveCompetitorOpportunities(siteId, [opp('teeth whitening cost')]);
    assert.deepEqual(res, { inserted: 1, updated: 0 });
    const [row] = await listCompetitorOpportunities(siteId);
    assert.equal(row.topic, 'teeth whitening cost');
    assert.equal(row.opportunity_type, 'missing');
    assert.equal(row.opportunity_score, 0.72);
    assert.equal(row.priority, 'high');
    assert.equal(row.lifecycle_state, 'discovered');
    assert.equal(row.competitor_evidence.competitors[0].domain, 'rival.com');
  });

  test('it enters the same queue the existing ship cycle reads, with the right source', async () => {
    const siteId = await makeSite('queue');
    await saveCompetitorOpportunities(siteId, [opp('implants price')]);
    const { rows } = await query(
      `SELECT source, status, observation_count FROM keyword_gaps WHERE site_id = $1`, [siteId]
    );
    assert.equal(rows[0].source, 'competitor_footprint');
    assert.equal(rows[0].status, 'pending_review');
    assert.equal(rows[0].observation_count, 1);
  });

  test('re-observing it next week raises the observation count instead of duplicating', async () => {
    const siteId = await makeSite('reobserve');
    await saveCompetitorOpportunities(siteId, [opp('teeth whitening cost')], { discoveryWeek: '2026-10-19' });
    const second = await saveCompetitorOpportunities(siteId, [opp('teeth whitening cost', { score: 0.8 })], { discoveryWeek: '2026-10-26' });
    assert.deepEqual(second, { inserted: 0, updated: 1 });
    const { rows } = await query('SELECT count(*)::int AS n, max(observation_count) AS obs FROM keyword_gaps WHERE site_id = $1', [siteId]);
    assert.equal(rows[0].n, 1);
    assert.equal(rows[0].obs, 2);
  });

  test('a fresh measurement replaces the stale one', async () => {
    const siteId = await makeSite('refresh');
    await saveCompetitorOpportunities(siteId, [opp('kw', { searchVolume: 100, bestCompetitorPosition: 9, ourPosition: 40 })], { discoveryWeek: '2026-10-19' });
    await saveCompetitorOpportunities(siteId, [opp('kw', { searchVolume: 900, bestCompetitorPosition: 2, ourPosition: 12 })], { discoveryWeek: '2026-10-26' });
    const [row] = await listCompetitorOpportunities(siteId);
    assert.equal(row.search_volume, 900);
    assert.equal(row.best_competitor_position, 2);
    assert.equal(row.our_position, 12);
  });

  test('a gap a human already dismissed never comes back', async () => {
    const siteId = await makeSite('dismissed');
    await saveCompetitorOpportunities(siteId, [opp('rejected kw')]);
    await query('UPDATE keyword_gaps SET status = $2 WHERE site_id = $1', [siteId, 'dismissed']);
    const res = await saveCompetitorOpportunities(siteId, [opp('rejected kw')]);
    assert.deepEqual(res, { inserted: 0, updated: 0 });
    const { rows } = await query('SELECT count(*)::int AS n FROM keyword_gaps WHERE site_id = $1', [siteId]);
    assert.equal(rows[0].n, 1);
  });

  test('a human\'s own content plan is not overwritten by a later run', async () => {
    const siteId = await makeSite('plan');
    await saveCompetitorOpportunities(siteId, [opp('kw', { contentPlan: 'blog' })], { discoveryWeek: '2026-10-19' });
    await query('UPDATE keyword_gaps SET content_plan = $2 WHERE site_id = $1', [siteId, 'landing']);
    await saveCompetitorOpportunities(siteId, [opp('kw', { contentPlan: 'blog' })], { discoveryWeek: '2026-10-26' });
    const [row] = await listCompetitorOpportunities(siteId);
    assert.equal(row.content_plan, 'landing');
  });

  test('priority follows the score band', async () => {
    const siteId = await makeSite('priority');
    await saveCompetitorOpportunities(siteId, [opp('high kw', { score: 0.9 }), opp('mid kw', { score: 0.4 }), opp('low kw', { score: 0.1 })]);
    const rows = await listCompetitorOpportunities(siteId);
    assert.deepEqual(
      rows.map((r) => [r.topic, r.priority]),
      [['high kw', 'high'], ['mid kw', 'medium'], ['low kw', 'low']]
    );
  });

  test('opportunities are per site', async () => {
    const a = await makeSite('iso-a');
    const b = await makeSite('iso-b');
    await saveCompetitorOpportunities(a, [opp('shared kw', { evidence: { secret: 'a-only' } })]);
    assert.equal((await listCompetitorOpportunities(b)).length, 0);
    assert.equal((await listCompetitorOpportunities(a)).length, 1);
  });

  test('the listing can be narrowed to one kind of work', async () => {
    const siteId = await makeSite('bytype');
    await saveCompetitorOpportunities(siteId, [opp('a kw', { opportunityType: 'improve_page' }), opp('b kw', { opportunityType: 'missing' })]);
    assert.deepEqual((await listCompetitorOpportunities(siteId, { opportunityType: 'improve_page' })).map((r) => r.topic), ['a kw']);
  });

  test('an unknown opportunity type or score is refused by the table', async () => {
    const siteId = await makeSite('checks');
    await assert.rejects(() => saveCompetitorOpportunities(siteId, [opp('bad', { opportunityType: 'rewrite_everything' })]), /opportunity_type_check/);
    await assert.rejects(() => saveCompetitorOpportunities(siteId, [opp('bad2', { score: 2 })]), /opportunity_score_check/);
  });
});

describe('lifecycle: a PR is not a result', () => {
  test('it moves forward through every stage', async () => {
    const siteId = await makeSite('lifecycle');
    await saveCompetitorOpportunities(siteId, [opp('kw')]);
    const [row] = await listCompetitorOpportunities(siteId);
    for (const state of ['drafted', 'merged', 'deployed', 'verified']) {
      const moved = await advanceOpportunityLifecycle(siteId, row.id, state);
      assert.equal(moved.lifecycle_state, state);
    }
  });

  test('it never moves backwards, so a re-run cannot undo a verified outcome', async () => {
    const siteId = await makeSite('backwards');
    await saveCompetitorOpportunities(siteId, [opp('kw')]);
    const [row] = await listCompetitorOpportunities(siteId);
    await advanceOpportunityLifecycle(siteId, row.id, 'verified');
    assert.equal(await advanceOpportunityLifecycle(siteId, row.id, 'drafted'), null);
    const [after] = await listCompetitorOpportunities(siteId);
    assert.equal(after.lifecycle_state, 'verified');
  });

  test('one project cannot move another project\'s work', async () => {
    const a = await makeSite('move-a');
    const b = await makeSite('move-b');
    await saveCompetitorOpportunities(a, [opp('kw')]);
    const [row] = await listCompetitorOpportunities(a);
    assert.equal(await advanceOpportunityLifecycle(b, row.id, 'drafted'), null);
  });

  test('an unknown state is refused before touching the database', async () => {
    const siteId = await makeSite('badstate');
    await assert.rejects(() => advanceOpportunityLifecycle(siteId, 1, 'shipped'), /Unknown lifecycle state/);
  });
});

describe('learning only from verified outcomes', () => {
  test('nothing is learned below the minimum sample', async () => {
    const siteId = await makeSite('minsample');
    for (let i = 0; i < MIN_VERIFIED - 1; i += 1) await recordOpportunityOutcome(siteId, 'missing', 'positive');
    assert.deepEqual(await getLearnedMultipliers(siteId), {});
  });

  test('work that keeps paying off is favoured, work that fails is discouraged, within bounds', async () => {
    const siteId = await makeSite('learned');
    for (let i = 0; i < 4; i += 1) await recordOpportunityOutcome(siteId, 'improve_page', 'positive');
    for (let i = 0; i < 4; i += 1) await recordOpportunityOutcome(siteId, 'new_page', 'negative');
    const m = await getLearnedMultipliers(siteId);
    assert.equal(m.improve_page, 1.3);
    assert.equal(m.new_page, 0.7);
  });

  test('a change that did nothing measurable counts towards the total but favours neither side', async () => {
    const siteId = await makeSite('neutral');
    for (let i = 0; i < 4; i += 1) await recordOpportunityOutcome(siteId, 'missing', 'neutral');
    const m = await getLearnedMultipliers(siteId);
    assert.equal(m.missing, 0.7);
    const { rows } = await query('SELECT verified_total, verified_positive, verified_negative FROM opportunity_type_outcomes WHERE site_id = $1', [siteId]);
    assert.deepEqual(rows[0], { verified_total: 4, verified_positive: 0, verified_negative: 0 });
  });

  test('learning is per project', async () => {
    const a = await makeSite('learn-a');
    const b = await makeSite('learn-b');
    for (let i = 0; i < 4; i += 1) await recordOpportunityOutcome(a, 'missing', 'positive');
    assert.deepEqual(await getLearnedMultipliers(b), {});
  });

  test('an unknown outcome is refused', async () => {
    const siteId = await makeSite('badoutcome');
    await assert.rejects(() => recordOpportunityOutcome(siteId, 'missing', 'shipped'), /Unknown outcome/);
  });

  test('deleting a site removes its opportunities and what was learned from them', async () => {
    const siteId = await makeSite('cascade');
    await saveCompetitorOpportunities(siteId, [opp('kw')]);
    await recordOpportunityOutcome(siteId, 'missing', 'positive');
    await query('DELETE FROM sites WHERE id = $1', [siteId]);
    for (const table of ['keyword_gaps', 'opportunity_type_outcomes']) {
      const { rows } = await query(`SELECT count(*)::int AS n FROM ${table} WHERE site_id = $1`, [siteId]);
      assert.equal(rows[0].n, 0, `${table} should be empty`);
    }
  });
});
