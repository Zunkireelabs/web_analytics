import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { getExecutionLifecycle, MIN_SAMPLES } from './behaviour-learning.js';
import { MIN_SAMPLES as LEARNING_MIN_SAMPLES } from '../agents/lib/generator-learning.js';

// Real DB: the point is the joins. The same PR number is planted on two sites with different deployment states, so a
// join that forgot site_id would attach one project's deployment to the other's draft and fail here.

const siteIds = [];
async function makeSite(label) {
  const stamp = `behaviour-learning-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('behaviour-learning.db.test.js fixture', $1, $2, 'UTC') RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM fix_impact WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM deployments WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM drafts WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

async function draft(siteId, { status = 'draft', prNumber = null, implemented = false, validation = null, actionType = 'faq' } = {}) {
  const { rows } = await query(
    `INSERT INTO drafts (site_id, action_type, input, content, status, pr_number, implemented_at, validation_status)
     VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, $3, $4, ${implemented ? "now() - interval '40 days'" : 'NULL'}, $5::jsonb)
     RETURNING id`,
    [siteId, actionType, status, prNumber, validation ? JSON.stringify(validation) : null]
  );
  return rows[0].id;
}
async function deployment(siteId, { prNumber, status, sha }) {
  const { rows } = await query(
    `INSERT INTO deployments (site_id, commit_sha, pr_number, status, merged_at) VALUES ($1, $2, $3, $4, now() - interval '40 days') RETURNING id`,
    [siteId, sha, prNumber, status]
  );
  return rows[0].id;
}
async function impact(siteId, draftId, { status, verdict = null, deploymentId = null }) {
  await query(
    `INSERT INTO fix_impact (site_id, draft_id, page_url, generator_id, merged_at, measure_after, status, delta, deployment_id)
     VALUES ($1, $2, '/p', 'faq', now() - interval '40 days', now() - interval '5 days', $3, $4::jsonb, $5)`,
    [siteId, draftId, status, verdict ? JSON.stringify({ verdict, clicks: 20 }) : null, deploymentId]
  );
}
const byId = (stages, id) => stages.find((s) => s.draftId === id);

describe('getExecutionLifecycle — real tables', () => {
  test('each draft lands at the right stage, and stages are never skipped ahead', async () => {
    const a = await makeSite('a');
    const d1 = await draft(a);
    const d2 = await draft(a, { status: 'pr_opened', prNumber: 11, validation: { qualityGate: { ok: true } } });
    const d3 = await draft(a, { status: 'implemented', prNumber: 12, implemented: true });
    await deployment(a, { prNumber: 12, status: 'pending', sha: 'sha-a-12' });
    const d4 = await draft(a, { status: 'implemented', prNumber: 13, implemented: true });
    const dep4 = await deployment(a, { prNumber: 13, status: 'deployed', sha: 'sha-a-13' });
    await impact(a, d4, { status: 'measured', verdict: 'impact-positive', deploymentId: dep4 });
    const d5 = await draft(a, { status: 'implemented', prNumber: 14, implemented: true }); // merged, nothing tracked
    const d6 = await draft(a, { status: 'abandoned' });

    const { stages, summary } = await getExecutionLifecycle(a);
    assert.equal(stages.length, 6);
    assert.equal(byId(stages, d1).furthest, 'generated');
    assert.deepEqual([byId(stages, d2).furthest, byId(stages, d2).validated, byId(stages, d2).merged], ['pr-opened', 'passed', false]);
    assert.deepEqual([byId(stages, d3).furthest, byId(stages, d3).deployment], ['merged', 'pending']);
    assert.deepEqual([byId(stages, d4).furthest, byId(stages, d4).deployment, byId(stages, d4).impact], ['measured', 'verified', 'positive']);
    assert.deepEqual([byId(stages, d5).furthest, byId(stages, d5).deployment], ['merged', 'untracked']);
    assert.equal(byId(stages, d6).abandoned, true);
    assert.equal(summary.deploymentVerified, 1);
    assert.equal(summary.mergedButUntracked, 1);
    assert.equal(summary.impact.positive, 1);
  });

  test("another project's rows never attach, even with the same PR number", async () => {
    const a = await makeSite('iso-a');
    const b = await makeSite('iso-b');
    const da = await draft(a, { status: 'implemented', prNumber: 77, implemented: true });
    await deployment(a, { prNumber: 77, status: 'pending', sha: 'sha-iso-a' });
    const db = await draft(b, { status: 'implemented', prNumber: 77, implemented: true });
    await deployment(b, { prNumber: 77, status: 'deployed', sha: 'sha-iso-b' });
    await impact(b, db, { status: 'measured', verdict: 'impact-negative' });

    const la = await getExecutionLifecycle(a);
    const lb = await getExecutionLifecycle(b);
    assert.deepEqual(la.stages.map((s) => s.draftId), [da], "A sees only A's draft");
    assert.equal(la.stages[0].deployment, 'pending', "A's own pending deployment, not B's deployed one");
    assert.equal(la.stages[0].impact, null, "B's measurement must not appear on A");
    assert.deepEqual(lb.stages.map((s) => s.draftId), [db]);
    assert.equal(lb.stages[0].deployment, 'verified');
    assert.equal(lb.stages[0].impact, 'negative');
  });

  test('a measurement recorded before verdicts existed is reported as legacy, not as a result', async () => {
    const a = await makeSite('legacy');
    const d = await draft(a, { status: 'implemented', prNumber: 5, implemented: true });
    const dep = await deployment(a, { prNumber: 5, status: 'deployed', sha: 'sha-legacy' });
    await impact(a, d, { status: 'measured', deploymentId: dep }); // delta without a verdict
    const { stages } = await getExecutionLifecycle(a);
    assert.equal(stages[0].impact, 'legacy');
  });

  test('a project with no drafts returns an empty, well-formed result', async () => {
    const a = await makeSite('empty');
    const r = await getExecutionLifecycle(a);
    assert.deepEqual(r.stages, []);
    assert.equal(r.summary.total, 0);
  });

  test('the evidence threshold used to explain experience matches the one the scorer uses', () => {
    assert.equal(MIN_SAMPLES, LEARNING_MIN_SAMPLES);
  });
});
