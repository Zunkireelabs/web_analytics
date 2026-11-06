import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../db.js';
import { growthStageFor, stageScore, STAGE_SWING } from './growth-stage.js';
import { snapshotProjectMemory, getProjectMemory } from './project-memory.js';
import { projectMemoryToEvidence } from './learning-evidence.js';
import { stagesFor } from './behaviour-learning.js';
import { scoreRecommendation } from '../agents/lib/growth-scoring.js';
import { buildDailyQueue } from '../agents/lib/daily-queue.js';
import { classifyRecommendation } from '../agents/lib/autonomy-decision.js';
import { measureOne } from '../agents/lib/fix-impact.js';
import { evaluateStartup } from './startup-checks.js';
import { designGateMode } from '../design-agent/lib/design-completeness.js';

// Final acceptance scenarios for the growth programme and the connected learning layers. Real database where the behaviour is in
// SQL, pure functions where it is in code. Fixtures carry a unique tag and are removed afterwards.

const TAG = `accept${Date.now()}`;
const siteIds = []; const wsIds = [];
const DAY = 24 * 60 * 60 * 1000;

async function newSite(label, extra = '') {
  const ws = (await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${TAG}-${label}`])).rows[0].id; wsIds.push(ws);
  const id = (await query(`INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain) VALUES ($1,$2,$2,'UTC',$3,$4) RETURNING id`,
    [`${TAG} ${label}`, `${TAG}-${label}`, ws, `${label}.${TAG}.example`])).rows[0].id; siteIds.push(id);
  return id;
}

after(async () => {
  if (siteIds.length) {
    for (const t of ['generator_outcomes', 'fix_impact', 'deployments', 'growth_stage_log', 'project_memory_log']) await query(`DELETE FROM ${t} WHERE site_id = ANY($1::int[])`, [siteIds]);
    await query('DELETE FROM drafts WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  if (wsIds.length) await query('DELETE FROM workspaces WHERE id = ANY($1::int[])', [wsIds]);
  await pool.end();
});

describe('growth stages', () => {
  const deployedAt = new Date('2026-12-01T09:00:00Z');
  const at = (days) => new Date(deployedAt.getTime() + days * DAY);

  test('an existing client whose clock starts at deployment: day 15 is Growth Acceleration', () => {
    const g = growthStageFor(deployedAt, at(14));
    assert.deepEqual([g.stage, g.day, g.label], ['acceleration', 15, 'Growth Acceleration']);
  });
  test('day 45 is Growth Expansion', () => assert.equal(growthStageFor(deployedAt, at(44)).stage, 'expansion'));
  test('day 90 is Continuous Optimisation', () => assert.equal(growthStageFor(deployedAt, at(89)).stage, 'optimisation'));
  test('the boundaries are exactly day 30/31 and 60/61', () => {
    assert.equal(growthStageFor(deployedAt, at(29)).stage, 'acceleration');
    assert.equal(growthStageFor(deployedAt, at(30)).stage, 'expansion');
    assert.equal(growthStageFor(deployedAt, at(59)).stage, 'expansion');
    assert.equal(growthStageFor(deployedAt, at(60)).stage, 'optimisation');
  });
  test('a missing or invalid clock is Day 1, flagged, and never a crash', () => {
    for (const bad of [null, undefined, 'not-a-date']) {
      const g = growthStageFor(bad, deployedAt);
      assert.deepEqual([g.stage, g.day, g.clock], ['acceleration', 1, 'missing-start-date']);
    }
  });

  test('migration 230 semantics: existing rows share the deployment moment, later rows get their own, and nothing is reset', async () => {
    const c = await pool.connect();
    try {
      const ADD = `ALTER TABLE t_sites ADD COLUMN IF NOT EXISTS growth_started_at TIMESTAMPTZ NOT NULL DEFAULT now()`; // exactly migration 230's statement
      await c.query(`CREATE TEMP TABLE t_sites (id serial primary key, name text)`);
      await c.query(`INSERT INTO t_sites (name) VALUES ('old-1'), ('old-2'), ('old-3')`);
      await c.query(ADD);
      const first = (await c.query(`SELECT DISTINCT growth_started_at FROM t_sites`)).rows;
      assert.equal(first.length, 1, 'every existing client starts at the same deployment moment');
      await c.query(`SELECT pg_sleep(0.05)`);
      await c.query(`INSERT INTO t_sites (name) VALUES ('new-client')`);
      const all = (await c.query(`SELECT name, growth_started_at FROM t_sites ORDER BY id`)).rows;
      assert.ok(all[3].growth_started_at > all[0].growth_started_at, 'a new client starts later, at its own creation');
      await c.query(ADD); // a later deploy re-runs the statement
      const again = (await c.query(`SELECT growth_started_at FROM t_sites ORDER BY id`)).rows;
      assert.equal(String(again[0].growth_started_at), String(all[0].growth_started_at), 'a later deploy resets nobody');
      const real = readFileSync(fileURLToPath(new URL('../migrations/230_growth_lifecycle.sql', import.meta.url)), 'utf8');
      assert.ok(real.includes('growth_started_at TIMESTAMPTZ NOT NULL DEFAULT now()'), 'the migration uses the statement this test proves');
    } finally { await c.query('DROP TABLE IF EXISTS t_sites'); c.release(); }
  });

  test('a newly onboarded client automatically starts at Day 1, with no onboarding code involved', async () => {
    const id = await newSite('newclient');
    const { rows } = await query('SELECT growth_started_at FROM sites WHERE id = $1', [id]);
    const g = growthStageFor(rows[0].growth_started_at, new Date());
    assert.deepEqual([g.stage, g.day, g.clock], ['acceleration', 1, 'ok']);
  });
});

describe('the four layers are connected to the work', () => {
  test('project memory is created for a new client and retrieved with its growth stage', async () => {
    const id = await newSite('memory');
    const snap = await snapshotProjectMemory(id, { reason: 'onboarding' });
    assert.equal(snap.found, true);
    const memory = await getProjectMemory(id);
    assert.equal(memory.growth.stage, 'acceleration');
    assert.equal(memory.growth.day, 1);
    const evidence = projectMemoryToEvidence(memory);
    const g = evidence.find((e) => e.meta?.section === 'growth');
    assert.match(g.summary, /day 1 of its growth programme: Growth Acceleration/);
    assert.match(g.summary, /critical issues are addressed at any stage/);
  });

  const rec = (id, type, page = `/p${id}`) => ({ id, recommendation_type: type, finding_ids: [id], params: { page } });

  test('verified outcomes change the order of the next day\'s work', () => {
    const a = rec(1, 'expand-content'); const b = rec(2, 'qa-content');
    const order = (learnedMap) => buildDailyQueue({ candidates: [a, b], remaining: 5, learnedMap }).queue.map((q) => q.rec.id);
    const aWins = order(new Map([['expand-content', { confidence: 0.9, impactConfidence: 0.9, attempts: 10 }], ['qa-content', { confidence: 0.3, impactConfidence: 0.2, attempts: 10 }]]));
    const bWins = order(new Map([['expand-content', { confidence: 0.3, impactConfidence: 0.2, attempts: 10 }], ['qa-content', { confidence: 0.9, impactConfidence: 0.9, attempts: 10 }]]));
    assert.equal(aWins[0], 1);
    assert.equal(bWins[0], 2);
  });

  const validated = (o = {}) => ({ industry: 'education', subIndustry: '', kind: 'generator-outcome', subject: 'expand-content', polarity: 'works', status: 'validated', confidence: 'medium', evidence: { sites: 4 }, ...o });
  test('industry knowledge moves the ranking only when it is validated, relevant and the project has no results of its own', () => {
    const base = scoreRecommendation(rec(1, 'expand-content'), {}).score;
    const withIt = (item, learned) => scoreRecommendation(rec(1, 'expand-content'), { industryMap: new Map([['expand-content', item]]), learnedMap: new Map(learned ? [['expand-content', learned]] : []) }).score;
    assert.ok(withIt(validated()) > base, 'validated and relevant lifts');
    assert.equal(withIt(validated({ status: 'candidate' })), base, 'emerging does nothing');
    assert.equal(withIt(validated({ status: 'contradicted', polarity: 'mixed' })), base, 'contradicted does nothing');
    assert.equal(withIt(validated({ status: 'stale' })), base, 'stale does nothing');
    assert.equal(withIt(validated({ confidence: 'low' })), base, 'low confidence does nothing');
    assert.equal(withIt(validated(), { impactConfidence: 0.6 }), scoreRecommendation(rec(1, 'expand-content'), { learnedMap: new Map([['expand-content', { impactConfidence: 0.6 }]]) }).score, 'the project\'s own results decide');
    assert.equal(scoreRecommendation(rec(1, 'meta-title'), { industryMap: new Map([['expand-content', validated()]]) }).score, scoreRecommendation(rec(1, 'meta-title'), {}).score, 'a pattern about another kind of change is not relevant');
  });

  test('the growth stage re-orders within a tier but a critical issue wins at every stage', () => {
    const critical = rec(1, 'canonical'); const expansion = rec(2, 'expand-content'); const content = rec(3, 'blog-outline');
    for (const stage of ['acceleration', 'expansion', 'optimisation']) {
      const growth = growthStageFor(new Date(Date.now() - { acceleration: 5, expansion: 40, optimisation: 90 }[stage] * DAY));
      const q = buildDailyQueue({ candidates: [content, expansion, critical], remaining: 5, growth }).queue.map((x) => x.rec.id);
      assert.equal(q[0], 1, `critical first at ${stage}`);
    }
    const lift = (stage, r) => stageScore({ stage, label: stage, day: 1 }, { 'expand-content': 3, 'blog-outline': 4 }[r.recommendation_type]).score;
    assert.ok(lift('expansion', expansion) > lift('acceleration', expansion), 'expansion stage favours expansion work');
    assert.ok(lift('expansion', content) > lift('acceleration', content), 'and new content');
    const biggest = Math.max(...Object.values(STAGE_SWING).flatMap((t) => Object.values(t)));
    assert.ok(biggest < 500, 'the stage can never cross a severity tier (1000)');
  });

  test('stage and industry scores never reach the autonomy decision', () => {
    assert.ok(classifyRecommendation.length <= 3);
    const src = classifyRecommendation.toString();
    for (const word of ['growth', 'stage', 'industry']) assert.ok(!src.includes(word), `classifyRecommendation mentions ${word}`);
  });
});

describe('outcomes are honest', () => {
  test('a deployment that was never confirmed live is not a success and records no learning outcome', async () => {
    const siteId = await newSite('faildeploy');
    const draftId = (await query(`INSERT INTO drafts (site_id, action_type, input, content, status, pr_number) VALUES ($1,'meta-title','{}'::jsonb,'{}'::jsonb,'implemented', 7) RETURNING id`, [siteId])).rows[0].id;
    const dep = (await query(`INSERT INTO deployments (site_id, commit_sha, pr_number, status, merged_at) VALUES ($1,$2,7,'not-detected', now() - interval '40 days') RETURNING id`, [siteId, `sha-${TAG}`])).rows[0].id;
    const fi = (await query(`INSERT INTO fix_impact (site_id, draft_id, page_url, generator_id, merged_at, measure_after, deployment_id) VALUES ($1,$2,'/x','meta-title', now() - interval '40 days', now() - interval '1 day', $3) RETURNING *`, [siteId, draftId, dep])).rows[0];

    const result = await measureOne(fi);
    assert.equal(result.status, 'insufficient-data', 'a change never confirmed live is not measured as if it were');
    assert.equal(result.delta, null);
    const outcomes = (await query(`SELECT outcome FROM generator_outcomes WHERE site_id = $1 AND generator_id = 'meta-title'`, [siteId])).rows;
    assert.deepEqual(outcomes, [], 'nothing was learned from a change that may never have shipped');

    const stages = stagesFor({ draft_id: draftId, action_type: 'meta-title', pr_number: 7, implemented_at: new Date(), deployment_status: 'not-detected', impact_status: 'insufficient-data', draft_status: 'implemented' });
    assert.equal(stages.deployment, 'not-detected');
    assert.notEqual(stages.furthest, 'deployed');
    assert.notEqual(stages.furthest, 'measured');
  });

  test('a PR that is only open is a PR, not a deployment', () => {
    const s = stagesFor({ draft_id: 1, action_type: 'meta-title', pr_number: 9, draft_status: 'pr_opened' });
    assert.equal(s.furthest, 'pr-opened');
    assert.equal(s.deployment, null);
  });
});

describe('configuration and safety boundaries', () => {
  test('missing required configuration is reported as blocked, never silently skipped', () => {
    const r = evaluateStartup({ env: {} });
    assert.ok(r.blocked.length >= 3);
    assert.ok(r.blocked.every((f) => f.recovery.length > 10));
  });
  test('a forgotten design-gate variable fails closed', () => assert.equal(designGateMode({}), 'enforce'));

  test('no code in the server merges a pull request: human merge cannot be bypassed', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const hits = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.js') || p.endsWith('.test.js')) continue;
        if (/pulls\.merge|pulls\/[^'"`]*\/merge|mergePullRequest|enableAutoMerge|auto_merge|merge_method/.test(readFileSync(p, 'utf8'))) hits.push(p.replace(root, ''));
      }
    };
    walk(root);
    assert.deepEqual(hits, []);
  });
});
