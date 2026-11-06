import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { loadDecisionRows, buildDataset } from './training-examples.js';
import { registerModel, recordEvaluation, promoteModel, rollbackModel, listModels, resolveModelOverride } from './model-adaptation.js';

const TAG = `madapt-${Date.now()}`;
const siteIds = []; const wsIds = []; const modelNames = [];

async function project(label, { share = true } = {}) {
  const ws = (await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${TAG}-ws`])).rows[0].id; wsIds.push(ws);
  const id = (await query(`INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain) VALUES ($1,$2,$2,'UTC',$3,$4) RETURNING id`,
    [`${TAG} Brandname ${label}`, `${TAG}-${label}`, ws, `${label}brand.${TAG}.example`])).rows[0].id; siteIds.push(id);
  await query(`INSERT INTO site_profiles (site_id, industry, share_industry_learning) VALUES ($1,'Education consultancy',$2)`, [id, share]);
  return id;
}
async function decided(siteId, { verdict = 'impact-positive', page = 'p', status = 'verified', mergedDaysAgo = 60 } = {}) {
  const d = (await query(`INSERT INTO drafts (site_id, action_type, input, content, status) VALUES ($1,'x','{}'::jsonb,'{}'::jsonb,'implemented') RETURNING id`, [siteId])).rows[0].id;
  const fi = (await query(
    `INSERT INTO fix_impact (site_id, draft_id, page_url, generator_id, merged_at, measure_after, status, delta)
     VALUES ($1,$2,$3,'x', now() - ($4 || ' days')::interval, now() - interval '30 days','measured',$5::jsonb) RETURNING id`,
    [siteId, d, `https://${TAG}.example/${page}`, String(mergedDaysAgo), JSON.stringify({ verdict })])).rows[0].id;
  await query(
    `INSERT INTO decisions (site_id, situation, evidence, action, rationale, confidence, status, outcome_ref)
     VALUES ($1,$2,$3::jsonb,'fix_metadata',$4,0.8,$5,$6)`,
    [siteId, `Titles on https://${TAG}.example/${page} repeat for Brandname`, JSON.stringify([{ source: 'agent', summary: 'two titles on a page of Brandname' }]), 'fix the titles', status, `fix_impact:${fi}`]);
}

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM decisions WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM fix_impact WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM drafts WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM site_profiles WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  if (wsIds.length) await query('DELETE FROM workspaces WHERE id = ANY($1::int[])', [wsIds]);
  await query(`DELETE FROM model_registry_log WHERE model_id IN (SELECT id FROM model_registry WHERE name = ANY($1))`, [modelNames]);
  await query(`DELETE FROM model_registry WHERE name = ANY($1)`, [modelNames]);
  await pool.end();
});

describe('model adaptation against the real database', () => {
  test('the dataset is built from real decisions, honours every exclusion and leaks nothing', async () => {
    const good = await project('good'); const optedOut = await project('out', { share: false });
    const neg = await project('neg'); const unmeasured = await project('unm'); const conf = await project('conf');
    await decided(good); await decided(optedOut); await decided(neg, { verdict: 'impact-negative' });
    await decided(unmeasured, { status: 'shipped' });
    await decided(conf, { page: 'same', mergedDaysAgo: 60 }); await decided(conf, { page: 'same', mergedDaysAgo: 58 });
    const rows = (await loadDecisionRows()).filter((r) => siteIds.includes(r.site_id ?? 0) || String(r.site_name).startsWith(TAG));
    const ds = buildDataset(rows);
    assert.equal(ds.manifest.counts.total, 1, JSON.stringify(ds.manifest));
    assert.equal(ds.manifest.excluded['project-opted-out'], 1);
    assert.equal(ds.manifest.excluded['negative-outcome'], 1);
    assert.equal(ds.manifest.excluded['no-measured-outcome'], 1);
    assert.equal(ds.manifest.excluded.confounded, 2);
    const text = JSON.stringify(ds);
    for (const leak of [TAG, 'Brandname', 'goodbrand', '.example', 'https']) assert.ok(!text.includes(leak), `leaked ${leak}`);
  });

  test('registry: gated promotion, one active model enforced by the database, rollback', async () => {
    const n = (s) => { const name = `${TAG}-${s}`; modelNames.push(name); return name; };
    const ev = (accuracy) => ({ datasetVersion: 'v-test', n: 100, accuracy, invalidRate: 0, perAction: {} });
    const base = await registerModel({ name: n('base'), provider: 'anthropic', modelId: `${TAG}-b`, kind: 'base', by: 't' });
    const ft1 = await registerModel({ name: n('ft1'), provider: 'anthropic', modelId: `${TAG}-f1`, kind: 'fine-tuned', datasetVersion: 'v-test', by: 't' });
    const ft2 = await registerModel({ name: n('ft2'), provider: 'anthropic', modelId: `${TAG}-f2`, kind: 'fine-tuned', datasetVersion: 'v-test', by: 't' });
    await recordEvaluation(base.id, ev(0.5), { by: 't' });
    await recordEvaluation(ft1.id, ev(0.6), { by: 't' });
    await recordEvaluation(ft2.id, ev(0.7), { by: 't' });

    const active = async () => (await listModels()).filter((m) => m.status === 'active' && modelNames.includes(m.name)).map((m) => m.name);
    assert.deepEqual(await active(), []);
    assert.equal(await resolveModelOverride('decision', { env: {} }), null);

    // the real incumbent would be another active model in this DB, so only assert on the models we created
    await promoteModel(ft1.id, { by: 't', reason: 'beats the baseline' });
    assert.deepEqual(await active(), [n('ft1')]);
    await promoteModel(ft2.id, { by: 't', reason: 'beats the first one' });
    assert.deepEqual(await active(), [n('ft2')], 'promoting retires the previous active model');

    // the database itself refuses a second active model
    await assert.rejects(query(`UPDATE model_registry SET status = 'active' WHERE id = $1`, [ft1.id]), /one_active/);

    const rb = await rollbackModel({ by: 't', reason: 'outputs looked off' });
    assert.equal(rb.restoredId, ft1.id);
    assert.deepEqual(await active(), [n('ft1')]);
    assert.equal((await resolveModelOverride('decision', { env: { MODEL_REGISTRY: 'on' } }))?.model, `${TAG}-f1`);

    const events = (await query(`SELECT event FROM model_registry_log WHERE model_id = ANY($1::bigint[]) ORDER BY id`, [[base.id, ft1.id, ft2.id]])).rows.map((r) => r.event);
    assert.ok(['registered', 'evaluated', 'promoted', 'rolled-back'].every((e) => events.includes(e)), events.join());
  });
});
