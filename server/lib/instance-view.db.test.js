import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { loadInstanceList, loadInstanceDetail } from './instance-view.js';

// Real Postgres. Plant marker text in every place a project keeps private material, then prove the instance view returns counts
// for it and never the text, and never another project's anything.
const TAG = `iv${Date.now()}`;
const siteIds = []; const wsIds = [];
async function seed(label) {
  const ws = (await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`WS-${label}-${TAG}`])).rows[0].id; wsIds.push(ws);
  const id = (await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain, onboarded_at, url_file_map, author_name)
     VALUES ($1,$2,$2,'UTC',$3,$4, now(), $5::jsonb, $6) RETURNING id`,
    [`Proj-${label}-${TAG}`, `sc-${label}-${TAG}`, ws, `${label}.${TAG}.example`, JSON.stringify({ siteRoot: { designProfile: { evidence: { notes: `DESIGN-${label}-${TAG}` } } } }), `AUTHOR-${label}-${TAG}`])).rows[0].id;
  siteIds.push(id);
  await query(`INSERT INTO agent_runs (site_id, agent_id, agent_version, input, status, facts, narrative, took_ms) VALUES ($1,'technical-seo','1','{}','ok',$2::jsonb,$3,1200)`,
    [id, JSON.stringify({ page: `https://${label}.${TAG}.example/secret-page` }), `NARRATIVE-${label}-${TAG}`]);
  await query(`INSERT INTO agent_runs (site_id, agent_id, agent_version, input, status, error, took_ms) VALUES ($1,'mobile-usability','1','{}','error',$2,300)`, [id, `ERR-${label}-${TAG}`]);
  await query(`INSERT INTO drafts (site_id, action_type, source, input, content, status) VALUES ($1,'faq','auto-remediation',$2::jsonb,$3::jsonb,'draft')`,
    [id, JSON.stringify({ page: `/draft-${label}-${TAG}` }), JSON.stringify({ body: `DRAFT-${label}-${TAG}` })]);
  await query(`INSERT INTO competitor_profiles (site_id, domain) VALUES ($1,$2)`, [id, `rival-${label}.${TAG}.example`]);
  return { id, label };
}
after(async () => {
  if (siteIds.length) {
    for (const t of ['agent_runs', 'drafts', 'competitor_profiles', 'project_memory_log', 'autonomous_daily_slots']) await query(`DELETE FROM ${t} WHERE site_id = ANY($1::int[])`, [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  if (wsIds.length) await query('DELETE FROM workspaces WHERE id = ANY($1::int[])', [wsIds]);
  await pool.end();
});

describe('instance view, real database', () => {
  test('returns counts for a project, never its private text, and never another project\'s', async () => {
    const A = await seed('A'); const B = await seed('B');
    const dA = await loadInstanceDetail(A.id);
    const dB = await loadInstanceDetail(B.id);
    // positive control: the real numbers are there
    assert.equal(dA.lastRun.agentsLast24h, 2);
    assert.equal(dA.lastRun.failedLast24h, 1);
    assert.equal(dA.last7Days.draftsOpened, 1);
    assert.equal(dA.last7Days.autonomousDrafts, 1);
    assert.equal(dA.last7Days.slowestAgent.id, 'technical-seo');
    assert.equal(dA.configuration.autonomousFixes, false);
    // text it must never contain
    const textA = JSON.stringify(dA);
    for (const leak of ['NARRATIVE-', 'ERR-', 'DRAFT-', 'DESIGN-', 'AUTHOR-', 'secret-page', 'draft-', 'rival-']) {
      assert.ok(!textA.includes(leak), `detail leaked ${leak}`);
    }
    for (const leak of [`-B-${TAG}`, `B.${TAG}`]) assert.ok(!textA.includes(leak), `A's detail contained B: ${leak}`);
    assert.ok(!JSON.stringify(dB).includes(`-A-${TAG}`));
    // the name and domain are the project's own, shown on purpose
    assert.equal(dA.name, `Proj-A-${TAG}`);
  });

  test('the list holds both projects with their own numbers and no private text', async () => {
    const list = await loadInstanceList();
    const mine = list.instances.filter((r) => String(r.name).includes(TAG));
    assert.equal(mine.length, 2);
    const text = JSON.stringify(list);
    for (const leak of ['NARRATIVE-', 'ERR-', 'DRAFT-', 'DESIGN-', 'AUTHOR-', 'secret-page', 'rival-']) assert.ok(!text.includes(leak), `list leaked ${leak}`);
    for (const r of mine) { assert.equal(r.state, 'running'); assert.equal(r.lastRun.agentsLast24h, 2); }
    assert.equal(typeof list.summary.running, 'number');
  });

  test('an unknown project, and a removed one, are not found', async () => {
    assert.equal(await loadInstanceDetail(999999999), null);
    const C = await seed('C');
    await query(`UPDATE sites SET status = 'soft_deleted' WHERE id = $1`, [C.id]);
    assert.equal(await loadInstanceDetail(C.id), null);
    assert.ok(!(await loadInstanceList()).instances.some((r) => r.id === C.id), 'removed projects are not listed');
  });

  test('daily capacity and today\'s usage come from the atomic ledger', async () => {
    const D = await seed('D');
    await query(`UPDATE sites SET surge_mode_until = now() + interval '10 days' WHERE id = $1`, [D.id]);
    const { takeSlot } = await import('../store/autonomous-slots.js');
    await takeSlot(D.id); await takeSlot(D.id);
    const d = await loadInstanceDetail(D.id);
    assert.equal(d.capacity.dailyCapacity, 100);
    assert.equal(d.capacity.usedToday, 2 + 1, 'the seed counts the 1 autonomous draft already made today, plus the 2 taken');
    assert.equal(d.surgeDetail.active, true);
  });

  test('it writes nothing: every statement it sends is a SELECT', async () => {
    const E = await seed('E');
    const sent = [];
    const recording = (sql, params) => { sent.push(String(sql)); return query(sql, params); };
    await loadInstanceList({ query: recording });
    await loadInstanceDetail(E.id, { query: recording, readiness: async () => ({ ready: true, items: [] }) });
    assert.ok(sent.length > 5, 'the recorder saw the queries');
    const notRead = sent.filter((q) => !/^\s*(SELECT|WITH)\b/i.test(q));
    assert.deepEqual(notRead, []);
  });
});
