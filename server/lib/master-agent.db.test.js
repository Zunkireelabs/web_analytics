import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { planDay, claimNext, runJob, drain, reapExhausted, masterTick, health, shadowReport, estimateMsBySite } from './master-agent.js';
import { withJobLock, jobKeyFor } from './job-lock.js';

// Real Postgres. Every project here is a throwaway row; the executor is always a fake that records what it was asked to do, so no
// real pipeline, Google call or model call ever runs. The point: the QUEUE's guarantees (one claim per job, leases, retries, limits,
// dedupe, shadow does nothing, the existing run wins) hold against the real database.
const TAG = `ma${Date.now()}`;
const ids = []; const wsIds = []; let cur = []; // cur: the projects made by the test that is running now
const NOW = new Date();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mk(label, o = {}) {
  const ws = (await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${TAG}-${label}`])).rows[0].id; wsIds.push(ws);
  const connected = o.connected !== false;
  const id = (await query(`INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain, onboarded_at, status) VALUES ($1,$2,$3,'UTC',$4,$5, now(), $6) RETURNING id`,
    [`${TAG} ${label}`, connected ? `sc-${label}-${TAG}` : null, connected ? `g-${label}-${TAG}` : null, ws, `${label}.${TAG}.example`, o.status || 'active'])).rows[0].id;
  ids.push(id); cur.push(id); return id;
}
const mine = (rows) => rows.filter((r) => ids.includes(r.site_id));
const jobsOf = async (siteIds) => (await query(`SELECT *, run_day::text AS day FROM instance_jobs WHERE site_id = ANY($1) ORDER BY priority, id`, [siteIds])).rows;
const clean = async () => { if (ids.length) await query('DELETE FROM instance_jobs WHERE site_id = ANY($1::int[])', [ids]); cur = []; };
// Every call below is scoped to the projects this test made (siteIds: cur), so tests never touch, or are touched by, other projects
// in the shared local database or other test files running at the same time.
const onlyMine = async (fn) => fn();
// instance_jobs is written only by the Master Agent and its tests, so leftovers from an earlier, interrupted run are test debris.
// Clear everything before starting, so a stale queued job for some other project cannot be claimed by these tests.
before(async () => { await query(`DELETE FROM instance_jobs`); });
after(async () => {
  await clean();
  if (ids.length) await query('DELETE FROM sites WHERE id = ANY($1::int[])', [ids]);
  if (wsIds.length) await query('DELETE FROM workspaces WHERE id = ANY($1::int[])', [wsIds]);
  await pool.end();
});

describe('planning', () => {
  test('one job per eligible project, none for unconnected or suspended ones, and planning twice adds nothing', async () => {
    const a = await mk('P1'); const b = await mk('P2'); const un = await mk('PU', { connected: false }); const sus = await mk('PS', { status: 'suspended' });
    await onlyMine(async () => {
      const first = await planDay({ mode: 'on', now: NOW, siteIds: cur });
      const second = await planDay({ mode: 'on', now: NOW, siteIds: cur });
      assert.equal(first.planned, 2);
      assert.equal(second.planned, 0, 'a second plan creates nothing');
      const jobs = await jobsOf([a, b, un, sus]);
      assert.deepEqual(jobs.map((j) => j.site_id).sort(), [a, b].sort());
      assert.ok(jobs.every((j) => j.state === 'queued' && j.mode === 'on'));
    });
    await clean();
  });

  test('a project that has waited longest goes first', async () => {
    const a = await mk('F1'); const b = await mk('F2');
    await query(`INSERT INTO instance_jobs (site_id, kind, run_day, state, mode, finished_at) VALUES ($1,'daily',(now() - interval '5 days')::date,'succeeded','on', now() - interval '5 days'), ($2,'daily',(now() - interval '1 day')::date,'succeeded','on', now() - interval '1 day')`, [a, b]);
    await onlyMine(async () => {
      await planDay({ mode: 'on', now: NOW, siteIds: cur });
      const jobs = (await jobsOf([a, b])).filter((j) => j.day === NOW.toISOString().slice(0, 10));
      assert.deepEqual(jobs.map((j) => j.site_id), [a, b]);
    });
    await clean();
  });

  test('shadow mode records what it would run and runs nothing; "on" later turns those into real jobs', async () => {
    const a = await mk('S1');
    await onlyMine(async () => {
      let executed = 0;
      const out = await masterTick({ mode: 'shadow', now: NOW, siteIds: cur, executor: async () => { executed++; }, factoryDeps: { ensureAnalystRegistered: async () => ({ status: 'already-registered' }), assessTenantReadiness: async () => ({ items: [] }), snapshotMemory: async () => {}, countMemoryVersions: async () => 1 } });
      assert.equal(executed, 0, 'shadow executes nothing');
      assert.equal(out.instances, undefined, 'shadow does not provision instances either: no analyst call, no memory write');
      assert.equal(out.drain, undefined, 'shadow does not even drain');
      const j = (await jobsOf([a]))[0];
      assert.deepEqual([j.state, j.mode], ['skipped', 'shadow']);
      assert.equal(j.result.wouldRun, true);
      // switch to on the same day: the shadow row becomes a real queued job
      await planDay({ mode: 'on', now: NOW, siteIds: cur });
      const j2 = (await jobsOf([a]))[0];
      assert.deepEqual([j2.state, j2.mode], ['queued', 'on']);
      assert.equal(j2.id, j.id, 'the same row, not a second job');
    });
    await clean();
  });

  test('mode off plans nothing and runs nothing', async () => {
    await mk('O1');
    const out = await masterTick({ mode: 'off', now: NOW });
    assert.equal(out.skipped, 'off');
    assert.equal((await planDay({ mode: 'off', now: NOW, siteIds: cur })).planned, 0);
    await clean();
  });
});

describe('claiming', () => {
  test('20 workers claiming at once: every job is taken exactly once, none twice', async () => {
    const sites = []; for (let i = 0; i < 8; i++) sites.push(await mk(`C${i}`));
    await onlyMine(async () => {
      await planDay({ mode: 'on', now: NOW, siteIds: cur });
      const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => claimNext({ workerId: `w${i}`, now: NOW, siteIds: cur })));
      const taken = claims.filter(Boolean);
      assert.equal(taken.length, 8);
      assert.equal(new Set(taken.map((j) => j.id)).size, 8, 'no job was handed to two workers');
      assert.ok(taken.every((j) => j.state === 'running' && j.attempts === 1));
    });
    await clean();
  });

  test('a worker that died: its job is taken again after the lease, then closed as failed when attempts run out', async () => {
    const a = await mk('L1');
    await onlyMine(async () => {
      await planDay({ mode: 'on', now: NOW, siteIds: cur });
      const first = await claimNext({ workerId: 'dead-1', leaseMs: 50, now: NOW, siteIds: cur });
      assert.equal(first.attempts, 1);
      assert.equal(await claimNext({ workerId: 'other', now: NOW, siteIds: cur }), null, 'a live lease is not taken');
      await sleep(80);
      const second = await claimNext({ workerId: 'rescuer', leaseMs: 50, now: NOW, siteIds: cur });
      assert.equal(second.id, first.id);
      assert.equal(second.attempts, 2);
      await sleep(80);
      assert.equal(await claimNext({ workerId: 'third', now: NOW, siteIds: cur }), null, 'attempts are used up');
      assert.equal(await reapExhausted({ now: NOW }), 1);
      const j = (await jobsOf([a]))[0];
      assert.equal(j.state, 'failed');
    });
    await clean();
  });
});

describe('running', () => {
  const plan = async (n, label) => { const s = []; for (let i = 0; i < n; i++) s.push(await mk(`${label}${i}`)); await planDay({ mode: 'on', now: NOW, siteIds: cur }); return s; };

  test('success, and the executor is given only its own project', async () => {
    const [a, b] = await (async () => { const x = await mk('R1'); const y = await mk('R2'); return [x, y]; })();
    await onlyMine(async () => {
      await planDay({ mode: 'on', now: NOW, siteIds: cur });
      const seen = [];
      const out = await drain({ siteIds: cur, executor: async (job, site) => { seen.push([job.site_id, site.id]); }, now: () => NOW, legacyRunning: async () => false });
      assert.equal(out.succeeded, 2);
      assert.ok(seen.every(([j, s]) => j === s), 'job and project always match');
      assert.deepEqual(seen.map(([j]) => j).sort(), [a, b].sort());
      assert.ok((await jobsOf([a, b])).every((j) => j.state === 'succeeded' && j.duration_ms >= 0 && j.locked_by === null));
    });
    await clean();
  });

  test('one project failing does not stop the others; it is retried later with backoff, then fails for good', async () => {
    const bad = await mk('X1'); const good = await mk('X2');
    await onlyMine(async () => {
      await planDay({ mode: 'on', now: NOW, siteIds: cur });
      const ex = async (job) => { if (job.site_id === bad) throw new Error('boom: the site returned 500'); };
      const out = await drain({ siteIds: cur, executor: ex, now: () => NOW, legacyRunning: async () => false });
      assert.equal(out.succeeded, 1);
      assert.equal(out.retried, 1);
      let j = (await jobsOf([bad]))[0];
      assert.equal(j.state, 'queued');
      assert.match(j.error, /boom/);
      assert.ok(new Date(j.run_after) > new Date(), 'run after a backoff, not immediately');
      assert.equal((await jobsOf([good]))[0].state, 'succeeded');
      // pretend the backoff has passed: the second attempt is the last
      await query(`UPDATE instance_jobs SET run_after = now() WHERE id = $1`, [j.id]);
      const out2 = await drain({ siteIds: cur, executor: ex, now: () => NOW, legacyRunning: async () => false });
      assert.equal(out2.failed, 1);
      j = (await jobsOf([bad]))[0];
      assert.equal(j.state, 'failed');
      assert.equal(j.attempts, 2);
    });
    await clean();
  });

  test('a project that overruns is closed as timed_out, is not retried, and the next project still runs', async () => {
    const slow = await mk('T1'); const fast = await mk('T2');
    await onlyMine(async () => {
      await planDay({ mode: 'on', now: NOW, siteIds: cur });
      const ex = async (job) => { if (job.site_id === slow) await sleep(400); };
      const out = await drain({ siteIds: cur, executor: ex, now: () => NOW, legacyRunning: async () => false, timeoutMs: 40, graceMs: 40 });
      assert.equal(out.timedOut, 1);
      assert.equal(out.succeeded, 1);
      const j = (await jobsOf([slow]))[0];
      assert.equal(j.state, 'timed_out');
      assert.equal(j.attempts, 1, 'not retried');
    });
    await clean();
  });

  test('concurrency is capped by the browser slots: 6 jobs, 4 workers, 1 slot never overlap', async () => {
    await plan(6, 'K');
    let live = 0; let peak = 0;
    await onlyMine(async () => {
      const out = await drain({ siteIds: cur, concurrency: 4, browserSlots: 1, now: () => NOW, legacyRunning: async () => false, executor: async () => { live++; peak = Math.max(peak, live); await sleep(15); live--; } });
      assert.equal(out.succeeded >= 6, true);
      assert.equal(peak, 1);
    });
    await clean();
  });

  test('with 3 browser slots and 4 workers, at most 3 run at once and it is faster', async () => {
    await plan(6, 'M');
    let live = 0; let peak = 0;
    await onlyMine(async () => {
      const t = Date.now();
      await drain({ siteIds: cur, concurrency: 4, browserSlots: 3, now: () => NOW, legacyRunning: async () => false, executor: async () => { live++; peak = Math.max(peak, live); await sleep(40); live--; } });
      assert.equal(peak, 3);
      assert.ok(Date.now() - t < 6 * 40, 'parallel is quicker than sequential');
    });
    await clean();
  });

  test('the existing daily run wins: while it holds its lock nothing is claimed; once it ends the queue resumes', async () => {
    const a = await mk('W1');
    await onlyMine(async () => {
      await planDay({ mode: 'on', now: NOW, siteIds: cur });
      await withJobLock(jobKeyFor('daily-job', 'all-sites'), async () => {
        let ran = 0;
        const out = await masterTick({ mode: 'on', now: NOW, siteIds: cur, executor: async () => { ran++; }, factoryDeps: { ensureAnalystRegistered: async () => ({ status: 'already-registered' }), assessTenantReadiness: async () => ({ items: [] }), snapshotMemory: async () => {}, countMemoryVersions: async () => 1 } });
        assert.equal(out.drain.stoppedReason, 'legacy-daily-run-active');
        assert.equal(ran, 0);
        assert.equal((await jobsOf([a]))[0].state, 'queued', 'the job was left for later, not lost');
      });
      const out = await drain({ siteIds: cur, executor: async () => {}, now: () => NOW });
      assert.equal(out.succeeded, 1);
    });
    await clean();
  });

  test('a project that stopped being eligible after planning is skipped, not run', async () => {
    const a = await mk('G1');
    await onlyMine(async () => {
      await planDay({ mode: 'on', now: NOW, siteIds: cur });
      await query(`UPDATE sites SET status = 'suspended' WHERE id = $1`, [a]);
      let ran = 0;
      const out = await drain({ siteIds: cur, executor: async () => { ran++; }, now: () => NOW, legacyRunning: async () => false });
      assert.equal(ran, 0);
      assert.equal(out.skipped, 1);
      await query(`UPDATE sites SET status = 'active' WHERE id = $1`, [a]);
    });
    await clean();
  });

  test('a window deadline stops new work and leaves the rest queued', async () => {
    await plan(3, 'D');
    await onlyMine(async () => {
      const out = await drain({ siteIds: cur, executor: async () => {}, now: () => NOW, legacyRunning: async () => false, deadlineAt: Date.now() - 1 });
      assert.equal(out.stoppedReason, 'window-closed');
      assert.equal(out.ran, 0);
    });
    await clean();
  });
});

describe('health and the shadow report', () => {
  test('health reports today\'s counts, a stuck job and a recent failure, and carries no project content', async () => {
    const a = await mk('H1'); const b = await mk('H2');
    const day = NOW.toISOString().slice(0, 10);
    await query(`INSERT INTO instance_jobs (site_id, kind, run_day, state, mode, error, finished_at) VALUES ($1,'daily',$2,'failed','on','secret-looking error text', now())`, [a, day]);
    await query(`INSERT INTO instance_jobs (site_id, kind, run_day, state, mode, lease_expires_at, locked_by) VALUES ($1,'daily',$2,'running','on', now() - interval '1 hour','dead')`, [b, day]);
    const h = await health({ now: NOW, mode: 'on' });
    assert.ok(h.today.failed >= 1);
    assert.ok(h.stuckRunning >= 1);
    assert.ok(h.recentFailures.some((f) => f.site_id === a));
    assert.deepEqual(Object.keys(h.recentFailures[0]).sort(), ['error', 'site_id', 'state']);
    await clean();
  });

  test('the shadow report lists projects planned but not run by the existing loop, and the reverse', async () => {
    const a = await mk('Z1'); const b = await mk('Z2');
    await query(`INSERT INTO instance_jobs (site_id, kind, run_day, state, mode, priority, estimate_ms) VALUES ($1,'daily',$2,'skipped','shadow',1,600000)`, [a, NOW.toISOString().slice(0, 10)]);
    await query(`INSERT INTO agent_runs (site_id, agent_id, agent_version, input, status, took_ms) VALUES ($1,'technical-seo','1','{}','ok',100)`, [b]);
    const r = await shadowReport({ now: NOW });
    assert.ok(r.plannedButLegacyDidNot.includes(a));
    assert.ok(r.legacyRanButNotPlanned.includes(b));
    assert.ok(r.estimatedMs.sequentialToday >= 600000);
    await query('DELETE FROM agent_runs WHERE site_id = $1', [b]);
    await clean();
  });

  test('estimates come from what the existing loop already recorded, and are empty without history', async () => {
    const a = await mk('E1');
    assert.equal((await estimateMsBySite([a])).size, 0);
    assert.equal((await estimateMsBySite([])).size, 0);
  });
});

describe('writes only its own tables', () => {
  test('planning and draining change nothing about the project itself or its other records', async () => {
    const a = await mk('N1');
    // Counted for THIS project only: other test files share the database and run at the same time.
    const snap = async () => (await query(`SELECT (SELECT row_to_json(s)::text FROM sites s WHERE id = $1) AS site, (SELECT count(*) FROM drafts WHERE site_id = $1)::int d, (SELECT count(*) FROM agent_runs WHERE site_id = $1)::int r, (SELECT count(*) FROM agent_instances WHERE site_id = $1)::int i`, [a])).rows[0];
    const before = await snap();
    await planDay({ mode: 'on', now: NOW, siteIds: cur });
    await drain({ siteIds: cur, executor: async () => {}, now: () => NOW, legacyRunning: async () => false });
    assert.deepEqual(await snap(), before);
    await clean();
  });
});

describe('scale, simulated (100 projects, a fake 12 ms "pipeline" standing in for a 12 minute one)', () => {
  test('every project runs exactly once; browser slots and workers set the speed; the order is the fairness order', async () => {
    const sites = [];
    for (let i = 0; i < 100; i++) sites.push(await mk(`SC${i}`));
    await onlyMine(async () => {
      const timeRun = async (concurrency, browserSlots) => {
        await query('DELETE FROM instance_jobs WHERE site_id = ANY($1::int[])', [sites]);
        await planDay({ mode: 'on', now: NOW, siteIds: cur });
        const order = []; let live = 0; let peak = 0;
        const t = Date.now();
        const out = await drain({ siteIds: cur, concurrency, browserSlots, now: () => NOW, legacyRunning: async () => false, executor: async (job) => { live++; peak = Math.max(peak, live); order.push(job.site_id); await sleep(12); live--; } });
        return { ms: Date.now() - t, peak, order, out };
      };
      const one = await timeRun(1, 1);
      const four = await timeRun(4, 4);
      const wide = await timeRun(8, 2);
      for (const r of [one, four, wide]) {
        assert.equal(r.out.succeeded, 100);
        assert.equal(new Set(r.order).size, 100, 'each project ran exactly once');
      }
      assert.equal(one.peak, 1);
      assert.equal(four.peak, 4);
      assert.equal(wide.peak, 2, 'eight workers but two browser slots: two at a time');
      assert.ok(four.ms < one.ms / 2, `4 workers with 4 slots should be well under half the sequential time (${four.ms} vs ${one.ms} ms)`);
      assert.ok(wide.ms > four.ms, 'fewer slots is slower, however many workers there are');
    });
    await clean();
  });
});

