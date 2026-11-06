import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../../db.js';
import { insertRecommendation, mergeIntoRecommendation, corroborateRecommendation } from '../../store/recommendations.js';
import { syncAnalystInsightsToActionCenter } from './analyst-seo-mapping.js';

// Real database: the point is what ends up in the row. Python-first and app-first findings of ONE issue must end as ONE open
// recommendation that names both detectors, and a different issue on the same page must stay its own recommendation.

let site;
const PAGE = 'https://corroboration-test.example/pricing';
const insight = { id: 1, metric_key: 'gsc_ctr', dimension_type: 'page', dimension_value: PAGE, period_start: '2026-11-01', insight_type: 'trend_shift', evidence: { pct_change: -30 }, severity: 'high' };
const ANALYST_FINDING = `analyst:gsc_ctr:trend_shift:2026-11-01:${PAGE}`;

before(async () => {
  const stamp = `corroboration-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, website_domain) VALUES ('analyst-corroboration.db.test.js fixture', $1, $2, 'UTC', 'corroboration-test.example') RETURNING *`,
    [stamp, stamp]);
  site = rows[0];
});
after(async () => {
  if (site) { await query('DELETE FROM recommendations WHERE site_id = $1', [site.id]); await query('DELETE FROM sites WHERE id = $1', [site.id]); }
  await pool.end();
});
const openRows = async (type = 'meta-title') => (await query(`SELECT * FROM recommendations WHERE site_id = $1 AND recommendation_type = $2 AND status = 'open'`, [site.id, type])).rows;
const clear = () => query('DELETE FROM recommendations WHERE site_id = $1', [site.id]);

describe('one issue, two detectors, one recommendation', () => {
  test('APP first, then the analyst sync: one row, the analyst recorded as supporter with its finding id', async () => {
    await clear();
    await insertRecommendation(site.id, { page: PAGE, recommendationType: 'meta-title', issue: 'Weak title', reason: 'app', params: { page: PAGE }, findingId: 'meta-audit:/pricing', detectingAgent: 'meta-audit', priority: 'medium', riskTier: 'safe' });
    const out = await syncAnalystInsightsToActionCenter(site.id, [insight], { site });
    const rows = await openRows();
    assert.equal(rows.length, 1, 'still one recommendation');
    assert.equal(out.corroborated, 1);
    assert.deepEqual(rows[0].detecting_agents, ['meta-audit']);
    assert.deepEqual(rows[0].supporting_agents, ['analyst-insights']);
    assert.deepEqual([...rows[0].finding_ids].sort(), ['meta-audit:/pricing', ANALYST_FINDING].sort());
  });

  test('ANALYST first, then the app detector merges: one row naming both', async () => {
    await clear();
    const out = await syncAnalystInsightsToActionCenter(site.id, [insight], { site });
    assert.equal(out.created, 1);
    const [row] = await openRows();
    await mergeIntoRecommendation(row.id, { findingId: 'meta-audit:/pricing', agentId: 'meta-audit', riskTier: row.risk_tier });
    const rows = await openRows();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].detecting_agents, ['analyst-insights']);
    assert.deepEqual(rows[0].supporting_agents, ['meta-audit']);
    assert.ok(rows[0].finding_ids.includes(ANALYST_FINDING) && rows[0].finding_ids.includes('meta-audit:/pricing'));
  });

  test('the analyst sync running again changes nothing (idempotent)', async () => {
    await clear();
    await insertRecommendation(site.id, { page: PAGE, recommendationType: 'meta-title', issue: 'x', reason: 'app', params: { page: PAGE }, findingId: 'meta-audit:/pricing', detectingAgent: 'meta-audit', priority: 'medium', riskTier: 'safe' });
    await syncAnalystInsightsToActionCenter(site.id, [insight], { site });
    await syncAnalystInsightsToActionCenter(site.id, [insight], { site });
    const [row] = await openRows();
    assert.deepEqual(row.supporting_agents, ['analyst-insights']);
    assert.equal(row.finding_ids.filter((f) => f === ANALYST_FINDING).length, 1);
  });

  test('corroboration never changes params, risk tier, priority or status', async () => {
    await clear();
    const rec = await insertRecommendation(site.id, { page: PAGE, recommendationType: 'meta-title', issue: 'x', reason: 'app reason', params: { page: PAGE, query: 'q' }, findingId: 'f1', detectingAgent: 'meta-audit', priority: 'low', riskTier: 'manual', blockedReason: 'needs a person' });
    await corroborateRecommendation(rec.id, { findingId: 'f2', agentId: 'analyst-fusion' });
    const [row] = await openRows();
    assert.deepEqual(row.params, { page: PAGE, query: 'q' });
    assert.equal(row.risk_tier, 'manual');
    assert.equal(row.priority, 'low');
    assert.equal(row.blocked_reason, 'needs a person');
    assert.equal(row.reason, 'app reason');
  });

  test('a DIFFERENT issue on the same page stays its own recommendation, untouched', async () => {
    await clear();
    await insertRecommendation(site.id, { page: PAGE, recommendationType: 'schema', issue: 'No schema', reason: 'app', params: { page: PAGE }, findingId: 'schema:/pricing', detectingAgent: 'schema-audit', priority: 'medium', riskTier: 'safe' });
    await syncAnalystInsightsToActionCenter(site.id, [insight], { site });
    const schema = await openRows('schema');
    const meta = await openRows('meta-title');
    assert.equal(schema.length, 1); assert.equal(meta.length, 1);
    assert.deepEqual(schema[0].supporting_agents, [], 'the schema row heard nothing from the analyst');
  });

  test('a closed recommendation is never corroborated', async () => {
    await clear();
    const rec = await insertRecommendation(site.id, { page: PAGE, recommendationType: 'meta-title', issue: 'x', reason: 'app', params: { page: PAGE }, findingId: 'f1', detectingAgent: 'meta-audit', priority: 'medium', riskTier: 'safe' });
    await query(`UPDATE recommendations SET status = 'superseded' WHERE id = $1`, [rec.id]);
    assert.equal(await corroborateRecommendation(rec.id, { findingId: 'f2', agentId: 'analyst-insights' }), null);
  });
});
