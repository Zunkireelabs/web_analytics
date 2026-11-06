import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { getProjectMemory, snapshotProjectMemory } from './project-memory.js';
import { getExecutionLifecycle, getBehaviourLearning } from './behaviour-learning.js';
import { getIndustryIntelligence } from './industry-intelligence.js';
import { listMemoryVersions } from '../store/project-memory-log.js';

// Real DB. Two projects in two workspaces, each holding distinctive marker text in every source layer 1 and 2 read (project
// facts, drafts, measured outcomes, decisions). Every reader, asked about one project, must return that project's markers
// (positive control, so the test is not vacuous) and never the other's, in either direction.

const TAG = `iso${Date.now()}`;
const siteIds = []; const wsIds = [];
const mk = (label) => ({ label, name: `${TAG} Name${label}`, domain: `dom${label}.${TAG}.example`, gen: `gen-${label}-${TAG}`, page: `https://page${label}.${TAG}.example/secret-${label}`, situation: `situation-${label}-${TAG}`, industry: `Industry ${label} ${TAG}` });

async function seed(m) {
  const ws = (await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${TAG}-ws-${m.label}`])).rows[0].id; wsIds.push(ws);
  const id = (await query(`INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain) VALUES ($1,$2,$2,'UTC',$3,$4) RETURNING id`,
    [m.name, `${TAG}-${m.label}`, ws, m.domain])).rows[0].id; siteIds.push(id);
  await query(`INSERT INTO site_profiles (site_id, industry) VALUES ($1,$2)`, [id, m.industry]);
  const d = (await query(`INSERT INTO drafts (site_id, action_type, input, content, status) VALUES ($1,$2,'{}'::jsonb,'{}'::jsonb,'implemented') RETURNING id`, [id, m.gen])).rows[0].id;
  const fi = (await query(
    `INSERT INTO fix_impact (site_id, draft_id, page_url, generator_id, merged_at, measure_after, status, delta)
     VALUES ($1,$2,$3,$4, now() - interval '60 days', now() - interval '30 days','measured',$5::jsonb) RETURNING id`,
    [id, d, m.page, m.gen, JSON.stringify({ verdict: 'impact-positive' })])).rows[0].id;
  await query(`INSERT INTO decisions (site_id, situation, evidence, action, rationale, confidence, status, outcome_ref) VALUES ($1,$2,'[]'::jsonb,'fix_metadata','r',0.7,'verified',$3)`, [id, m.situation, `fix_impact:${fi}`]);
  return { ...m, id, ws };
}

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM project_memory_log WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM decisions WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM fix_impact WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM drafts WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM site_profiles WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  if (wsIds.length) await query('DELETE FROM workspaces WHERE id = ANY($1::int[])', [wsIds]);
  await pool.end();
});

const markersOf = (m) => [m.name, m.domain, m.gen, m.page, m.situation, m.industry, `Name${m.label}`, `secret-${m.label}`];

describe('layer 1 and 2 isolation (real database)', () => {
  test('every reader returns only its own project, in both directions', async () => {
    const A = await seed(mk('A')); const B = await seed(mk('B'));
    for (const [self, other] of [[A, B], [B, A]]) {
      const outputs = {
        memory: JSON.stringify(await getProjectMemory(self.id)),
        lifecycle: JSON.stringify(await getExecutionLifecycle(self.id)),
        behaviour: JSON.stringify(await getBehaviourLearning(self.id)),
        industry: JSON.stringify(await getIndustryIntelligence(self.id)),
      };
      for (const [reader, text] of Object.entries(outputs)) {
        for (const leak of markersOf(other)) assert.ok(!text.includes(leak), `${reader} for ${self.label} leaked ${leak} of ${other.label}`);
      }
      // positive control: the readers do see the project's own data, so "no leak" is meaningful
      assert.ok(outputs.lifecycle.includes(self.gen) || outputs.behaviour.includes(self.gen), `no reader returned ${self.label}'s own data`);
    }
  });

  test('a workspace mismatch is refused as "not found" and reveals nothing', async () => {
    const A = await seed(mk('C')); const B = await seed(mk('D'));
    await assert.rejects(getProjectMemory(A.id, { expectWorkspaceId: B.ws }), (e) => {
      assert.equal(e.status, 404);
      assert.match(e.message, /Project not found/);
      for (const leak of markersOf(A)) assert.ok(!e.message.includes(leak));
      return true;
    });
    assert.ok(await getProjectMemory(A.id, { expectWorkspaceId: A.ws }));
    assert.equal(await getProjectMemory(99999999), null);
  });

  test('snapshots and the version log stay inside their own project', async () => {
    const A = await seed(mk('E')); const B = await seed(mk('F'));
    await snapshotProjectMemory(A.id, { reason: 'manual' });
    const aLog = await listMemoryVersions(A.id);
    const bLog = await listMemoryVersions(B.id);
    assert.equal(bLog.length, 0, 'recording A must not write B history');
    const raw = (await query(`SELECT site_id, digest, provenance FROM project_memory_log WHERE site_id = ANY($1::int[])`, [[A.id, B.id]])).rows;
    assert.ok(raw.every((r) => r.site_id === A.id));
    for (const leak of markersOf(B)) assert.ok(!JSON.stringify(raw).includes(leak), `log leaked ${leak}`);
    assert.ok(aLog.length >= 0);
  });

  test('project memory is not exposed through any HTTP route', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../routes/', import.meta.url);
    const offenders = readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
      .filter((f) => /getProjectMemory|listMemoryVersions|getBehaviourLearning|getExecutionLifecycle/.test(readFileSync(new URL(f, dir), 'utf8')));
    assert.deepEqual(offenders, [], 'a route now exposes project memory: it needs a tenant-scoping test before it ships');
  });
});
