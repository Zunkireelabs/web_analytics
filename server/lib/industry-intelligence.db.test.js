import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { refreshIndustryKnowledge, getIndustryIntelligence, loadIndustryMap } from './industry-intelligence.js';
import { scoreRecommendation } from '../agents/lib/growth-scoring.js';

// Real DB: the point is the SQL. Projects in several workspaces are planted with measured outcomes; the test checks the
// shared table gets counts only, that an opted-out or low-confidence project does not count, and that retrieval returns
// only the project's own industry. Fixtures use a unique industry-neutral marker and are removed afterwards.

const TAG = `industry-intelligence-db-${Date.now()}`;
const siteIds = [];
const workspaceIds = [];
const GEN = `ii-test-gen-${Date.now() % 100000}`;

async function workspace() {
  const { rows } = await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${TAG}-ws`]);
  workspaceIds.push(rows[0].id);
  return rows[0].id;
}
async function site(ws, { industry = 'Education consultancy', source = 'human', confidence = 'high', share = true, label }) {
  const stamp = `${TAG}-${label}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain)
     VALUES ($1, $2, $2, 'UTC', $3, $4) RETURNING id`,
    [`${TAG} fixture ${label}`, stamp, ws, `${label}.${TAG}.example`]
  );
  const id = rows[0].id;
  siteIds.push(id);
  await query(
    `INSERT INTO site_profiles (site_id, industry, industry_source, industry_confidence, share_industry_learning)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, industry, source, confidence, share]
  );
  return id;
}
async function outcome(siteId, verdict, n = 2) {
  for (let i = 0; i < n; i += 1) {
    const { rows } = await query(
      `INSERT INTO drafts (site_id, action_type, input, content, status) VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 'implemented') RETURNING id`,
      [siteId, GEN]
    );
    await query(
      `INSERT INTO fix_impact (site_id, draft_id, page_url, generator_id, merged_at, measure_after, status, delta)
       VALUES ($1, $2, $3, $4, now() - interval '60 days', now() - interval '30 days', 'measured', $5::jsonb)`,
      [siteId, rows[0].id, `https://secret-page.${TAG}.example/p${i}`, GEN, JSON.stringify({ verdict, clicks: 5 })]
    );
  }
}

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM fix_impact WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM drafts WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM site_profiles WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  if (workspaceIds.length) await query('DELETE FROM workspaces WHERE id = ANY($1::int[])', [workspaceIds]);
  await query(`DELETE FROM industry_knowledge_log WHERE subject = $1`, [GEN]);
  await query(`DELETE FROM industry_knowledge WHERE subject = $1`, [GEN]);
  await pool.end();
});

describe('industry intelligence against the real database', () => {
  test('three projects agreeing validate a pattern; opted-out and low-confidence projects do not count; nothing identifying is stored', async () => {
    const a = await site(await workspace(), { label: 'a' });
    const b = await site(await workspace(), { label: 'b' });
    const c = await site(await workspace(), { label: 'c' });
    const optedOut = await site(await workspace(), { label: 'out', share: false });
    const lowConf = await site(await workspace(), { label: 'low', confidence: 'low', source: 'llm-classified' });
    for (const s of [a, b, c, optedOut, lowConf]) await outcome(s, 'impact-positive');

    const summary = await refreshIndustryKnowledge();
    assert.ok(summary.skipped['opted-out'] >= 1);
    assert.ok(summary.skipped['industry-low-confidence'] >= 1);

    const { rows } = await query(`SELECT * FROM industry_knowledge WHERE subject = $1 AND sub_industry = ''`, [GEN]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].industry, 'education');
    assert.equal(rows[0].status, 'validated');
    assert.equal(rows[0].evidence.sites, 3, 'opted-out and low-confidence projects must not be counted');
    assert.equal(rows[0].evidence.workspaces, 3);
    assert.ok(rows[0].expires_at, 'validated knowledge expires');
    const blob = JSON.stringify(rows);
    for (const secret of [TAG, 'secret-page', 'example', ...[a, b, c].map((id) => `"${id}"`)]) assert.ok(!blob.includes(secret), `leaked ${secret}`);
  });

  test('a validated pattern reaches the ranking only when the flag is on, and only for that industry', async () => {
    const edu = await site(await workspace(), { label: 'edu-rank' });
    const health = await site(await workspace(), { label: 'health-rank', industry: 'Dental clinic' });
    const rec = { id: 1, recommendation_type: GEN, finding_ids: [1], params: { page: '/p' } };
    const off = await loadIndustryMap(edu, { deps: { enabled: false } });
    assert.equal(off.size, 0);
    const eduMap = await loadIndustryMap(edu, { deps: { enabled: true } });
    const healthMap = await loadIndustryMap(health, { deps: { enabled: true } });
    assert.ok(eduMap.has(GEN));
    assert.ok(!healthMap.has(GEN));
    const base = scoreRecommendation(rec, {});
    const lifted = scoreRecommendation(rec, { industryMap: eduMap });
    assert.ok(lifted.score > base.score, 'validated positive pattern lifts the score');
    assert.equal(scoreRecommendation(rec, { industryMap: healthMap }).score, base.score);
  });

  test('retrieval gives a healthcare project healthcare knowledge, never education\'s', async () => {
    const edu = await site(await workspace(), { label: 'edu-r' });
    const health = await site(await workspace(), { label: 'health-r', industry: 'Dental clinic' });
    const eduOut = await getIndustryIntelligence(edu);
    const healthOut = await getIndustryIntelligence(health);
    assert.equal(eduOut.industry, 'education');
    assert.equal(healthOut.industry, 'healthcare');
    assert.ok(eduOut.validated.some((i) => i.subject === GEN));
    assert.ok(!healthOut.validated.some((i) => i.subject === GEN));
    for (const i of [...healthOut.startingPoints, ...healthOut.validated]) assert.equal(i.industry, 'healthcare');
    assert.ok(healthOut.startingPoints.length > 0);
  });

  test('when a contributing project opts out, the next refresh demotes the pattern instead of leaving it validated', async () => {
    await query(
      `UPDATE site_profiles SET share_industry_learning = false
        WHERE site_id = (SELECT id FROM sites WHERE gsc_property = $1)`, [`${TAG}-a`]);
    await refreshIndustryKnowledge();
    const { rows } = await query(`SELECT status, evidence FROM industry_knowledge WHERE subject = $1 AND sub_industry = ''`, [GEN]);
    assert.equal(rows[0].evidence.sites, 2);
    assert.equal(rows[0].status, 'candidate');
    assert.equal(rows[0].expires_at ?? null, null);
  });

  test('a project with no recorded industry gets nothing and a reason', async () => {
    const { rows } = await query(`INSERT INTO sites (name, gsc_property, ga4_property_id, timezone) VALUES ($1, $2, $2, 'UTC') RETURNING id`, [`${TAG} noprofile`, `${TAG}-np`]);
    siteIds.push(rows[0].id);
    const out = await getIndustryIntelligence(rows[0].id);
    assert.equal(out.classified, false);
    assert.equal(out.validated.length, 0);
  });
});
