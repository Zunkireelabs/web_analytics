import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { refreshIndustryKnowledge, getIndustryIntelligence } from './industry-intelligence.js';
import { reviewKnowledge, getKnowledgeHistory, getGovernanceReport } from './learning-governance.js';

// Real DB. Four projects in four workspaces with measured outcomes; checks the contamination guard, review (hide / restore),
// the append-only log, and that nothing tenant-identifying reaches the shared tables or their log.

const TAG = `lgov-db-${Date.now()}`;
const GEN = `lg-test-gen-${Date.now() % 100000}`;
const siteIds = [];
const workspaceIds = [];

async function workspace() {
  const { rows } = await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${TAG}-ws`]);
  workspaceIds.push(rows[0].id);
  return rows[0].id;
}
async function site(label) {
  const ws = await workspace();
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain) VALUES ($1,$2,$2,'UTC',$3,$4) RETURNING id`,
    [`${TAG} ${label}`, `${TAG}-${label}`, ws, `${label}.${TAG}.example`]
  );
  siteIds.push(rows[0].id);
  await query(`INSERT INTO site_profiles (site_id, industry, industry_source, industry_confidence) VALUES ($1,'Education consultancy','human','high')`, [rows[0].id]);
  return rows[0].id;
}
async function outcome(siteId, verdict, page, mergedDaysAgo = 60) {
  const { rows } = await query(`INSERT INTO drafts (site_id, action_type, input, content, status) VALUES ($1,$2,'{}'::jsonb,'{}'::jsonb,'implemented') RETURNING id`, [siteId, GEN]);
  await query(
    `INSERT INTO fix_impact (site_id, draft_id, page_url, generator_id, merged_at, measure_after, status, delta)
     VALUES ($1,$2,$3,$4, now() - ($5 || ' days')::interval, now() - interval '30 days','measured',$6::jsonb)`,
    [siteId, rows[0].id, page, GEN, String(mergedDaysAgo), JSON.stringify({ verdict })]
  );
}
const stored = async () => (await query(`SELECT * FROM industry_knowledge WHERE subject = $1 AND industry = 'education' AND sub_industry = ''`, [GEN])).rows[0];

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

describe('learning governance against the real database', () => {
  test('shared tables have no tenant columns at all', async () => {
    for (const table of ['industry_knowledge', 'industry_knowledge_log']) {
      const { rows } = await query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]);
      const names = rows.map((r) => r.column_name);
      assert.ok(names.length > 5);
      assert.ok(!names.some((n) => /site_id|workspace_id|domain|url|email/.test(n)), `${table} has a tenant column: ${names}`);
    }
  });

  test('guard, log, review and isolation', async () => {
    const [a, b, c, d] = [await site('a'), await site('b'), await site('c'), await site('d')];
    // d has TWO fixes on the same page 3 days apart: both set aside, so d casts no vote.
    for (const s of [a, b, c]) for (const p of [1, 2]) await outcome(s, 'impact-positive', `https://${TAG}.example/${s}/p${p}`);
    await outcome(d, 'impact-negative', `https://secret.${TAG}.example/same`, 60);
    await outcome(d, 'impact-negative', `https://secret.${TAG}.example/same`, 57);

    await refreshIndustryKnowledge();
    let row = await stored();
    assert.equal(row.status, 'validated');
    assert.equal(row.evidence.sites, 3, 'the confounded project must not vote');
    assert.equal(row.evidence.confounded, 2);

    // created once, and a second identical refresh does not grow the log
    const n1 = (await getKnowledgeHistory({ id: row.id })).length;
    assert.equal(n1, 1);
    await refreshIndustryKnowledge();
    assert.equal((await getKnowledgeHistory({ id: row.id })).length, 1);

    // served before review...
    assert.ok((await getIndustryIntelligence(a)).validated.some((i) => i.subject === GEN));
    // ...hidden once quarantined, with who and why on record, and restored by approval
    await reviewKnowledge({ id: row.id, state: 'quarantined', by: 'test reviewer', reason: 'checking a suspicious spike' });
    assert.ok(!(await getIndustryIntelligence(a)).validated.some((i) => i.subject === GEN));
    await refreshIndustryKnowledge();
    row = await stored();
    assert.equal(row.review_state, 'quarantined', 'a refresh must not undo a person\'s decision');
    assert.ok(!(await getIndustryIntelligence(a)).validated.some((i) => i.subject === GEN));
    await reviewKnowledge({ id: row.id, state: 'approved', by: 'test reviewer', reason: 'checked, data is fine' });
    assert.ok((await getIndustryIntelligence(a)).validated.some((i) => i.subject === GEN));

    const hist = await getKnowledgeHistory({ id: row.id });
    assert.deepEqual(hist.map((h) => h.event).sort(), ['created', 'reviewed', 'reviewed']);
    assert.ok(hist.some((h) => h.actor === 'test reviewer' && /suspicious/.test(h.reason)));

    // nothing tenant-identifying anywhere in the shared rows or their log
    const dump = JSON.stringify([row, hist]);
    for (const leak of [TAG, 'secret.', String(a) + '"', 'example']) assert.ok(!dump.includes(leak), `leaked ${leak}`);

    // project d (a different workspace) does not see a's data: its answer is the shared knowledge only
    const intel = await getIndustryIntelligence(d);
    assert.ok(!JSON.stringify(intel).includes(TAG));

    // the report sees the pattern and the set-aside outcomes
    const report = await getGovernanceReport();
    assert.ok(report.quality.setAsideOutcomes >= 2);
  });
});
