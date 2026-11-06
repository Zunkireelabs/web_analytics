import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pipelineConfig, minutesOf, runDateIn, todayAt, pastDeadline } from './config.js';
import { runDailyPipeline } from './orchestrator.js';
import { nightlyPipelineFinished, waitForNightlyPipeline, defaultStages, FindingsNotConfirmed, FINDINGS_COMPLETE_TASK } from './stages.js';

// ---- an in-memory stand-in for store/pipeline-runs.js with the same rules --------------------------------------------------
function memoryStore() {
  const rows = new Map(); // `${site}|${date}|${stage}` -> { status, attempts, error }
  const key = (s, d, st) => `${s}|${d}|${st}`;
  return {
    rows,
    async beginStage(s, d, st, { maxAttempts = 3 } = {}) {
      const k = key(s, d, st); const r = rows.get(k);
      if (!r) { rows.set(k, { status: 'running', attempts: 1 }); return { start: true, attempt: 1 }; }
      if ((r.status === 'failed' || r.status === 'deferred') && r.attempts < maxAttempts) { r.status = 'running'; r.attempts += 1; return { start: true, attempt: r.attempts }; }
      return { start: false, status: r.status, attempts: r.attempts };
    },
    async finishStage(s, d, st, { details } = {}) { Object.assign(rows.get(key(s, d, st)), { status: 'done', details }); },
    async failStage(s, d, st, err) { Object.assign(rows.get(key(s, d, st)) || rows.set(key(s, d, st), { attempts: 1 }).get(key(s, d, st)), { status: 'failed', error: String(err?.message || err) }); },
    async deferStage(s, d, st, reason) { const r = rows.get(key(s, d, st)); if (!r) rows.set(key(s, d, st), { status: 'deferred', attempts: 0, error: reason }); else if (['failed', 'deferred'].includes(r.status)) Object.assign(r, { status: 'deferred', error: reason }); },
    async skipStage(s, d, st, reason) { if (!rows.has(key(s, d, st))) rows.set(key(s, d, st), { status: 'skipped', attempts: 1, details: { reason } }); else Object.assign(rows.get(key(s, d, st)), { status: 'skipped', details: { reason } }); },
    status: (s, d, st) => rows.get(key(s, d, st))?.status,
  };
}

const config = { graceMs: 1000, perSiteBudgetMs: 60000, maxAttempts: 3 };
const sites = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
const noRotate = (l) => l;
const quiet = { log() {}, logError() {} };
// a deadline wrapper that just runs the function, like the real one when nothing overruns
const direct = async (site, fn) => { try { return { ok: true, value: await fn({ deadlineAt: null, isAborted: () => false }) }; } catch (error) { return { ok: false, error }; } };

const stage = (name, run, extra = {}) => ({ name, run, ...extra });

describe('config', () => {
  test('the pipeline is off unless DAILY_PIPELINE_ENABLED is exactly "true"', () => {
    assert.equal(pipelineConfig({}).enabled, false);
    assert.equal(pipelineConfig({ DAILY_PIPELINE_ENABLED: '1' }).enabled, false);
    assert.equal(pipelineConfig({ DAILY_PIPELINE_ENABLED: 'TRUE' }).enabled, false);
    assert.equal(pipelineConfig({ DAILY_PIPELINE_ENABLED: 'true' }).enabled, true);
  });
  test('defaults: Kathmandu, 05:30 start, 07:45 live design, 10:50 deadline, shipping not prepared-only', () => {
    const c = pipelineConfig({});
    assert.equal(c.timezone, 'Asia/Kathmandu');
    assert.equal(c.startCron, '30 5 * * *');
    assert.equal(c.liveDesignFrom, '07:45');
    assert.equal(c.prepDeadline, '10:50');
    assert.equal(c.shipPreparedOnly, false);
    assert.equal(c.maxCorrectionLoops, 2);
  });
  test('bad numbers fall back to the defaults', () => {
    assert.equal(pipelineConfig({ PIPELINE_MAX_ATTEMPTS: 'x' }).maxAttempts, 3);
    assert.equal(pipelineConfig({ PIPELINE_MAX_ATTEMPTS: '-2' }).maxAttempts, 3);
  });
  test('minutesOf reads clock times and refuses anything else', () => {
    assert.equal(minutesOf('05:30'), 330);
    assert.equal(minutesOf('7:45'), 465);
    assert.equal(minutesOf('24:00'), null);
    assert.equal(minutesOf('noon'), null);
  });
  test('Kathmandu is UTC+5:45: 05:30 there is 23:45 UTC the day before', () => {
    const now = new Date('2026-11-05T00:30:00Z'); // 06:15 in Kathmandu
    assert.equal(runDateIn('Asia/Kathmandu', now), '2026-11-05');
    assert.equal(new Date(todayAt('05:30', 'Asia/Kathmandu', now)).toISOString(), '2026-11-04T23:45:00.000Z');
    assert.equal(new Date(todayAt('10:50', 'Asia/Kathmandu', now)).toISOString(), '2026-11-05T05:05:00.000Z');
  });
  test('the run date follows the pipeline timezone, not UTC', () => {
    assert.equal(runDateIn('Asia/Kathmandu', new Date('2026-11-04T23:50:00Z')), '2026-11-05'); // 05:35 in Kathmandu
    assert.equal(runDateIn('UTC', new Date('2026-11-04T23:50:00Z')), '2026-11-04');
  });
  test('Design Agent quiet hours (21:00-02:00 UTC) end at 07:45 Kathmandu', () => {
    assert.equal(new Date(todayAt('07:45', 'Asia/Kathmandu', new Date('2026-11-05T03:00:00Z'))).toISOString(), '2026-11-05T02:00:00.000Z');
  });
  test('pastDeadline', () => {
    assert.equal(pastDeadline(null, 5), false);
    assert.equal(pastDeadline(10, 9), false);
    assert.equal(pastDeadline(10, 10), true);
  });
});

describe('orchestrator', () => {
  test('runs every stage in order for every project, then does nothing on a second pass (idempotent)', async () => {
    const store = memoryStore(); const calls = [];
    const stages = ['research', 'analyst', 'prepare'].map((n) => stage(n, async ({ site }) => { calls.push(`${site.id}:${n}`); }));
    const args = { sites, stages, store, runDate: '2026-11-05', config, rotate: noRotate, runWithDeadline: direct, ...quiet };
    await runDailyPipeline(args);
    assert.deepEqual(calls, ['1:research', '1:analyst', '1:prepare', '2:research', '2:analyst', '2:prepare']);
    await runDailyPipeline(args);
    assert.equal(calls.length, 6, 'a finished stage is never run again');
  });

  test('a failing optional stage does not stop the project or any other project', async () => {
    const store = memoryStore(); const calls = [];
    const stages = [
      stage('research', async ({ site }) => { calls.push(`${site.id}:research`); }),
      stage('analyst', async ({ site }) => { calls.push(`${site.id}:analyst`); if (site.id === 1) throw new Error('boom'); }),
      stage('prepare', async ({ site }) => { calls.push(`${site.id}:prepare`); }),
    ];
    const out = await runDailyPipeline({ sites, stages, store, runDate: 'd', config, rotate: noRotate, runWithDeadline: direct, ...quiet });
    assert.deepEqual(calls, ['1:research', '1:analyst', '1:prepare', '2:research', '2:analyst', '2:prepare']);
    assert.equal(store.status(1, 'd', 'analyst'), 'failed');
    assert.deepEqual(out.sites[0].failed, ['analyst']);
    assert.equal(store.status(2, 'd', 'analyst'), 'done');
  });

  test('a failing required stage stops only that project: the rest of its stages do not run, other projects are untouched', async () => {
    const store = memoryStore(); const calls = [];
    const stages = [
      stage('research', async ({ site }) => { calls.push(`${site.id}:research`); if (site.id === 1) throw new Error('google down'); }),
      stage('analyst', async ({ site }) => { calls.push(`${site.id}:analyst`); }),
    ];
    await runDailyPipeline({ sites, stages, store, runDate: 'd', config, rotate: noRotate, runWithDeadline: direct, ...quiet });
    assert.deepEqual(calls, ['1:research', '2:research', '2:analyst']);
  });

  test('a failed stage is retried on a later pass, and stops after maxAttempts', async () => {
    const store = memoryStore(); let n = 0;
    const stages = [stage('research', async () => { n++; throw new Error('still down'); })];
    const args = { sites: [sites[0]], stages, store, runDate: 'd', config: { ...config, maxAttempts: 3 }, rotate: noRotate, runWithDeadline: direct, ...quiet };
    for (let i = 0; i < 5; i++) await runDailyPipeline(args);
    assert.equal(n, 3, 'three attempts, no more');
  });

  test('a retry that succeeds is recorded done and is not run again', async () => {
    const store = memoryStore(); let n = 0;
    const stages = [stage('analyst', async () => { n++; if (n === 1) throw new Error('once'); })];
    const args = { sites: [sites[0]], stages, store, runDate: 'd', config, rotate: noRotate, runWithDeadline: direct, ...quiet };
    await runDailyPipeline(args); await runDailyPipeline(args); await runDailyPipeline(args);
    assert.equal(n, 2);
    assert.equal(store.status(1, 'd', 'analyst'), 'done');
  });

  test('after the deadline no new project starts and nothing is shipped or duplicated: work stays for the next cycle', async () => {
    const store = memoryStore(); const calls = [];
    const stages = [stage('research', async ({ site }) => { calls.push(site.id); })];
    const out = await runDailyPipeline({ sites, stages, store, runDate: 'd', deadlineAt: 100, now: () => 200, config, rotate: noRotate, runWithDeadline: direct, ...quiet });
    assert.deepEqual(calls, []);
    assert.equal(out.deadlineReached, true);
    assert.equal(store.rows.size, 0, 'a project that never started leaves no rows');
  });

  test('a deadline that passes in the middle of a project defers its remaining stages, and a later pass can take them', async () => {
    const store = memoryStore(); let clock = 0;
    const stages = [
      stage('research', async () => { clock = 500; }), // takes us past the deadline
      stage('analyst', async () => {}),
    ];
    const args = { sites: [sites[0]], stages, store, runDate: 'd', deadlineAt: 400, now: () => clock, config, rotate: noRotate, runWithDeadline: direct, ...quiet };
    const out = await runDailyPipeline(args);
    assert.equal(store.status(1, 'd', 'research'), 'done');
    assert.equal(store.status(1, 'd', 'analyst'), 'deferred');
    assert.deepEqual(out.sites[0].deferred, ['analyst']);
  });

  test('a stage with notBefore waits with no row written, and a later pass takes it', async () => {
    const store = memoryStore(); let clock = 100; const calls = [];
    const stages = [stage('design-live', async () => { calls.push('live'); }, { notBefore: 1000 })];
    const args = { sites: [sites[0]], stages, store, runDate: 'd', now: () => clock, config, rotate: noRotate, runWithDeadline: direct, ...quiet };
    const first = await runDailyPipeline(args);
    assert.deepEqual(calls, []);
    assert.deepEqual(first.sites[0].waiting, ['design-live']);
    assert.equal(store.rows.size, 0);
    clock = 1500;
    await runDailyPipeline(args);
    assert.deepEqual(calls, ['live']);
  });

  test('a stage that is not ready waits (no row, no attempt), other stages carry on, and a later pass runs it once ready', async () => {
    const store = memoryStore(); let ready = false; const calls = [];
    const stages = [
      stage('analyst', async () => { calls.push('analyst'); }, { ready: async () => ready, notReadyReason: 'no marker' }),
      stage('generate', async () => { calls.push('generate'); }),
    ];
    const args = { sites: [sites[0]], stages, store, runDate: 'd', config, rotate: noRotate, runWithDeadline: direct, ...quiet };
    const first = await runDailyPipeline(args);
    assert.deepEqual(calls, ['generate'], 'the gate did not block the next stage');
    assert.deepEqual(first.sites[0].waiting, ['analyst']);
    assert.equal(store.status(1, 'd', 'analyst'), undefined, 'no row and no attempt while waiting');
    ready = true;
    await runDailyPipeline(args);
    assert.deepEqual(calls, ['generate', 'analyst']);
    assert.equal(store.status(1, 'd', 'analyst'), 'done');
  });

  test('a stage still not ready at the deadline is recorded as deferred WITH its reason (visible, never silent)', async () => {
    const store = memoryStore();
    const stages = [stage('analyst', async () => {}, { ready: async () => false, notReadyReason: 'no findings_complete marker' })];
    await runDailyPipeline({ sites: [sites[0]], stages, store, runDate: 'd', deadlineAt: 100, now: () => 50, config, rotate: noRotate, runWithDeadline: direct, ...quiet });
    assert.equal(store.status(1, 'd', 'analyst'), undefined, 'before the deadline it only waits');
    const clock = { t: 50 };
    const s2 = [stage('first', async () => { clock.t = 200; }), stage('analyst', async () => {}, { ready: async () => false, notReadyReason: 'no findings_complete marker' })];
    await runDailyPipeline({ sites: [sites[1]], stages: s2, store, runDate: 'd', deadlineAt: 100, now: () => clock.t, config, rotate: noRotate, runWithDeadline: direct, ...quiet });
    assert.equal(store.status(2, 'd', 'analyst'), 'deferred');
    assert.match(store.rows.get('2|d|analyst').error, /no findings_complete marker by the daily deadline/);
  });

  test('a ready() that throws counts as not ready, never as ready', async () => {
    const store = memoryStore(); let ran = false;
    await runDailyPipeline({ sites: [sites[0]], stages: [stage('analyst', async () => { ran = true; }, { ready: async () => { throw new Error('db down'); } })], store, runDate: 'd', config, rotate: noRotate, runWithDeadline: direct, ...quiet });
    assert.equal(ran, false);
  });

  test('a stage that reports skip is recorded as skipped and never retried', async () => {
    const store = memoryStore(); let n = 0;
    const stages = [stage('generate', async () => { n++; return { skip: 'not-wired' }; })];
    const args = { sites: [sites[0]], stages, store, runDate: 'd', config, rotate: noRotate, runWithDeadline: direct, ...quiet };
    await runDailyPipeline(args); await runDailyPipeline(args);
    assert.equal(n, 1);
    assert.equal(store.status(1, 'd', 'generate'), 'skipped');
  });

  test('isolation: each stage is handed only its own project', async () => {
    const store = memoryStore(); const seen = [];
    const stages = [stage('research', async (ctx) => { seen.push(Object.keys(ctx).sort().join(',')); assert.ok(ctx.site); })];
    await runDailyPipeline({ sites, stages, store, runDate: 'd', config, rotate: noRotate, runWithDeadline: direct, ...quiet });
    assert.equal(new Set(seen).size, 1);
    assert.ok(!seen[0].includes('sites'), 'the list of every project is never passed to a stage');
  });

  test('a project that overruns its budget is recorded failed against the stage in flight, and the next project still runs', async () => {
    const store = memoryStore(); const calls = [];
    const stages = [stage('research', async ({ site }) => { calls.push(site.id); if (site.id === 1) await new Promise(() => {}); })];
    const timesOut = async (site, fn) => {
      if (site.id !== 1) return direct(site, fn);
      fn({ deadlineAt: null, isAborted: () => false }); // starts and never returns
      await new Promise((r) => setTimeout(r, 20));
      return { ok: false, timedOut: true };
    };
    const out = await runDailyPipeline({ sites, stages, store, runDate: 'd', config, rotate: noRotate, runWithDeadline: timesOut, ...quiet });
    assert.deepEqual(calls, [1, 2]);
    assert.equal(store.status(1, 'd', 'research'), 'failed');
    assert.equal(store.status(2, 'd', 'research'), 'done');
    assert.deepEqual(out.sites[0].failed, ['research']);
  });

  test('a stage already running elsewhere (or out of attempts) is left alone', async () => {
    const store = memoryStore(); store.rows.set('1|d|research', { status: 'running', attempts: 1 });
    let n = 0;
    await runDailyPipeline({ sites: [sites[0]], stages: [stage('research', async () => { n++; })], store, runDate: 'd', config, rotate: noRotate, runWithDeadline: direct, ...quiet });
    assert.equal(n, 0);
  });
});

describe('waiting for the Data Analyst Python pipeline', () => {
  const since = Date.parse('2026-11-04T18:15:00Z');
  const marker = (n) => async (sql, params) => { assert.match(sql, /task_type = \$2/); assert.equal(params[1], FINDINGS_COMPLETE_TASK); return { rows: [{ complete: n }] }; };

  test('finished means the findings_complete marker was written since the day began, and nothing else counts', async () => {
    assert.equal(await nightlyPipelineFinished({ query: marker(1), sinceMs: since }), true);
    assert.equal(await nightlyPipelineFinished({ query: marker(0), sinceMs: since }), false);
  });

  test('waits and polls until the marker appears', async () => {
    let calls = 0; let t = 0;
    const query = async () => ({ rows: [{ complete: calls++ >= 2 ? 1 : 0 }] });
    assert.equal(await waitForNightlyPipeline({ query, sinceMs: since, untilMs: 10000, now: () => t, wait: async (ms) => { t += ms; }, pollMs: 100 }), true);
    assert.equal(calls, 3);
  });

  test('gives up at the wait deadline', async () => {
    let t = 0;
    assert.equal(await waitForNightlyPipeline({ query: marker(0), sinceMs: since, untilMs: 500, now: () => t, wait: async (ms) => { t += ms; }, pollMs: 100 }), false);
  });

  test('an unreadable table counts as not finished, never as finished', async () => {
    let t = 0;
    assert.equal(await waitForNightlyPipeline({ query: async () => { throw new Error('no such table'); }, sinceMs: since, untilMs: 300, now: () => t, wait: async (ms) => { t += ms; }, pollMs: 100 }), false);
  });

  test('the analyst stage is not ready without the marker, and its run refuses (syncs nothing) even if called directly', async () => {
    const synced = [];
    const stages = defaultStages({ config: {}, startOfDayMs: since, analystWaitUntilMs: 0, liveDesignFromMs: 0, deps: {
      '../../db.js': { query: marker(0) },
      '../../agents/lib/analyst-fusion.js': { runAnalystFusion: async () => { synced.push('fusion'); return {}; } },
      '../../job.js': { fetchAnalystInsights: async () => { synced.push('fetch'); return []; } },
      '../../agents/lib/analyst-seo-mapping.js': { syncAnalystInsightsToActionCenter: async () => { synced.push('sync'); return {}; } },
    } });
    const analyst = stages.find((s) => s.name === 'analyst');
    assert.equal(await analyst.ready(), false);
    await assert.rejects(() => analyst.run({ site: { id: 1 } }), FindingsNotConfirmed);
    assert.deepEqual(synced, []);
  });

  test('two-month-old insights are never synced, even with the marker present', async () => {
    const synced = [];
    const old = new Date(Date.now() - 62 * 864e5).toISOString();
    const stages = defaultStages({ config: {}, startOfDayMs: since, analystWaitUntilMs: 0, liveDesignFromMs: 0, deps: {
      '../../db.js': { query: marker(1) },
      '../../agents/lib/analyst-fusion.js': { runAnalystFusion: async () => ({ created: 0 }) },
      '../../job.js': { fetchAnalystInsights: async () => [{ generated_at: old }, { generated_at: old }] },
      '../../agents/lib/analyst-seo-mapping.js': { syncAnalystInsightsToActionCenter: async () => { synced.push('sync'); return { created: 1 }; } },
    } });
    const out = await stages.find((s) => s.name === 'analyst').run({ site: { id: 1 } });
    assert.deepEqual(synced, []);
    assert.equal(out.staleSkipped, 2);
  });

  test('with the marker present the analyst stage runs fusion and the sync', async () => {
    const synced = [];
    const stages = defaultStages({ config: {}, startOfDayMs: since, analystWaitUntilMs: 0, liveDesignFromMs: 0, deps: {
      '../../db.js': { query: marker(1) },
      '../../agents/lib/analyst-fusion.js': { runAnalystFusion: async () => { synced.push('fusion'); return { created: 1 }; } },
      '../../job.js': { fetchAnalystInsights: async () => { synced.push('fetch'); return [{ generated_at: new Date().toISOString() }]; } },
      '../../agents/lib/analyst-seo-mapping.js': { syncAnalystInsightsToActionCenter: async () => { synced.push('sync'); return { created: 2 }; } },
    } });
    const out = await stages.find((s) => s.name === 'analyst').run({ site: { id: 1 } });
    assert.deepEqual(synced, ['fusion', 'fetch', 'sync']);
    assert.equal(out.findingsConfirmed, true);
  });
});
