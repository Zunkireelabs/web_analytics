import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../db.js';
import { createDesignAgentJob, createComponentTemplateJob } from '../store/execution-jobs.js';
import { processOneJob, createWorker } from './worker.js';
import { createMockHandler } from './test-support/mock-handler.js';
import { createDesignAgentHandler } from './openhands-handler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const testSupportDir = path.join(here, 'test-support');

// Integration coverage against the real DB (Postgres FOR UPDATE SKIP LOCKED
// semantics can't be meaningfully faked with a mock pool) — mirrors the
// atomic-claim pattern proven in store/oauth-refresh-tokens.js. Everything
// this suite creates is scoped to one throwaway site and torn down in
// `after`, so it never leaves rows behind in the shared DB.

let siteId;
const recIds = [];

let recSeq = 0;

async function makeRecommendation() {
  // recommendations_dedup_key (077b) is unique on (site_id, page,
  // recommendation_type) for open rows — each fixture needs its own page so
  // parallel test cases (and the 8 jobs in the concurrency test) don't collide.
  const page = `/test-page-${Date.now()}-${recSeq++}`;
  const { rows } = await query(
    `INSERT INTO recommendations (site_id, page, recommendation_type, issue, params, finding_ids, detecting_agents, risk_tier)
     VALUES ($1, $2, 'meta-title', 'worker test fixture', '{}', '{}', '{}', 'manual')
     RETURNING id`,
    [siteId, page]
  );
  recIds.push(rows[0].id);
  return rows[0].id;
}

async function makeQueuedJob() {
  const recommendationId = await makeRecommendation();
  return createDesignAgentJob(siteId, recommendationId, { requestedBy: null });
}

before(async () => {
  const stamp = `test-worker-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('design-agent-worker.test.js fixture', $1, $2, 'UTC')
     RETURNING id`,
    [stamp, stamp]
  );
  siteId = rows[0].id;
});

after(async () => {
  await query('DELETE FROM execution_jobs WHERE site_id = $1', [siteId]);
  if (recIds.length) await query('DELETE FROM recommendations WHERE id = ANY($1::int[])', [recIds]);
  await query('DELETE FROM sites WHERE id = $1', [siteId]);
  await pool.end();
});

describe('processOneJob — single-job lifecycle', () => {
  test('returns null when the queue is empty', async () => {
    // Drain anything already queued for this site so this check is accurate.
    let leftover = await processOneJob({ handler: createMockHandler() });
    while (leftover) leftover = await processOneJob({ handler: createMockHandler() });
    assert.equal(await processOneJob({ handler: createMockHandler() }), null);
  });

  test('claims a queued job, transitions to executing then completed, and logs both', async () => {
    const job = await makeQueuedJob();
    const result = await processOneJob({ handler: createMockHandler() });
    assert.equal(result.jobId, job.id);
    assert.equal(result.status, 'completed');

    const { rows } = await query('SELECT * FROM execution_jobs WHERE id = $1', [job.id]);
    const finished = rows[0];
    assert.equal(finished.status, 'completed');
    assert.ok(finished.started_at);
    assert.ok(finished.finished_at);
    assert.ok(finished.duration_ms >= 0);
    const messages = finished.logs.map((l) => l.message);
    assert.ok(messages.some((m) => m.includes('Claimed by worker pid')));
    assert.ok(messages.some((m) => m.includes('completed')));
  });

  test('a throwing handler leaves the job failed, not stuck executing', async () => {
    const job = await makeQueuedJob();
    const result = await processOneJob({ handler: createMockHandler({ shouldFail: true }) });
    assert.equal(result.status, 'failed');

    const { rows } = await query('SELECT status, finished_at, logs FROM execution_jobs WHERE id = $1', [job.id]);
    assert.equal(rows[0].status, 'failed');
    assert.ok(rows[0].finished_at);
    assert.ok(rows[0].logs.map((l) => l.message).some((m) => m.includes('Job failed')));
  });

  test('default handler (no OpenHands yet) fails the job with a clear "not implemented" message', async () => {
    await makeQueuedJob();
    const result = await processOneJob();
    assert.equal(result.status, 'failed');
    assert.match(result.error, /not implemented/i);
  });
});

describe('concurrency — two workers racing the same queue', () => {
  test('each job is claimed exactly once; no duplicate claims, none left unprocessed', async () => {
    const jobs = await Promise.all(Array.from({ length: 8 }, () => makeQueuedJob()));
    const claimedBy = new Map(); // jobId -> count of handler invocations

    const onRun = (job) => claimedBy.set(job.id, (claimedBy.get(job.id) || 0) + 1);
    const handlerA = createMockHandler({ delayMs: 30, onRun });
    const handlerB = createMockHandler({ delayMs: 30, onRun });

    // Two independent worker instances (standing in for two OS processes —
    // they share nothing but the DB, exactly like two real `node worker.js`
    // invocations would) both draining the same queue concurrently.
    async function drain(handler) {
      let processed = 0;
      let result = await processOneJob({ handler });
      while (result) {
        processed++;
        result = await processOneJob({ handler });
      }
      return processed;
    }

    const [countA, countB] = await Promise.all([drain(handlerA), drain(handlerB)]);

    assert.equal(countA + countB, jobs.length, 'every job was processed by exactly one of the two workers');
    assert.equal(claimedBy.size, jobs.length, 'no job was left unclaimed');
    for (const [jobId, count] of claimedBy) {
      assert.equal(count, 1, `job ${jobId} was claimed more than once`);
    }

    const { rows } = await query(
      'SELECT status FROM execution_jobs WHERE id = ANY($1::int[])',
      [jobs.map((j) => j.id)]
    );
    assert.ok(rows.every((r) => r.status === 'completed'));
  });
});

// Real Postgres round-trips over the network dominate every timing budget
// below (each poll does a claim transaction + 2 log writes + a finish
// update) — these waits are sized generously above that, and every test
// stops its own worker in `finally` so a slow/failed assertion can never
// leak a still-running poll loop into the next test.
async function waitFor(conditionFn, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor: condition not met before timeout');
}

describe('createWorker — polling lifecycle', () => {
  test('prevents overlapping polls: a slow job blocks the next poll until it settles', async () => {
    await makeQueuedJob();
    await makeQueuedJob();
    const polls = []; // { at, claimedJob }
    const handlerDelayMs = 500; // well above real network jitter for one round-trip
    const worker = createWorker({
      pollIntervalMs: 10,
      handler: createMockHandler({ delayMs: handlerDelayMs }),
      onPoll: (result) => polls.push({ at: Date.now(), claimedJob: result !== null }),
    });
    try {
      worker.start();
      // Wait for both real jobs to have been claimed and settled — once the
      // queue drains, later polls legitimately speed back up (nothing to
      // wait on), so only the two job-claiming polls are meaningful here.
      await waitFor(() => polls.filter((p) => p.claimedJob).length >= 2, { timeoutMs: 15_000 });
    } finally {
      await worker.stop();
    }

    const jobPolls = polls.filter((p) => p.claimedJob);
    assert.equal(jobPolls.length, 2, 'expected exactly the 2 queued jobs to have been claimed');
    // The gap between the two job-claiming polls' completion times must be
    // at least the handler's own delay — proof the second job's claim never
    // started while the first job's handler was still running (structurally
    // guaranteed by createWorker awaiting currentPoll before re-arming its
    // timer; this is the empirical check).
    const gap = jobPolls[1].at - jobPolls[0].at;
    assert.ok(gap >= handlerDelayMs * 0.8, `second job's poll started too soon after the first settled (gap ${gap}ms)`);
  });

  test('graceful shutdown: stop() waits for the in-flight job, leaves nothing stuck in executing', async () => {
    const job = await makeQueuedJob();
    let handlerStarted = false;
    const worker = createWorker({
      pollIntervalMs: 10,
      handler: createMockHandler({ delayMs: 300, onRun: () => { handlerStarted = true; } }),
    });
    try {
      worker.start();
      // Wait until the handler is actually mid-flight (job claimed) before
      // sending the simulated SIGTERM — not a fixed sleep, since the claim
      // itself is a real network round-trip of variable duration.
      await waitFor(() => handlerStarted, { timeoutMs: 10_000 });

      const stopStartedAt = Date.now();
      await worker.stop(); // simulates SIGTERM's handler calling worker.stop()
      const stopElapsedMs = Date.now() - stopStartedAt;

      // stop() only resolved once the in-flight handler actually finished —
      // proof the shutdown didn't abandon the job mid-flight.
      assert.ok(stopElapsedMs >= 250, `stop() resolved too fast (${stopElapsedMs}ms) to have waited for the handler`);
    } finally {
      await worker.stop();
    }
    const { rows } = await query('SELECT status FROM execution_jobs WHERE id = $1', [job.id]);
    assert.notEqual(rows[0].status, 'executing');
    assert.ok(['completed', 'failed'].includes(rows[0].status));
  });

  test('stop() before any job is claimed leaves the queue untouched', async () => {
    const job = await makeQueuedJob();
    const worker = createWorker({ pollIntervalMs: 5, handler: createMockHandler({ delayMs: 500 }) });
    // Never started — stop() should be a safe no-op.
    await worker.stop();
    const { rows } = await query('SELECT status FROM execution_jobs WHERE id = $1', [job.id]);
    assert.equal(rows[0].status, 'queued');
  });
});

describe('componentTemplates job — full real-DB lifecycle through the dispatching handler', () => {
  test('createComponentTemplateJob -> claim -> dispatch -> completed, with params and result round-tripping through Postgres JSONB', async () => {
    // Drain any job left queued by an earlier test in this file (e.g. "stop()
    // before any job is claimed" deliberately leaves one behind) — otherwise
    // the shared FIFO queue could hand processOneJob below that leftover
    // instead of the job this test just created.
    let leftover = await processOneJob({ handler: createMockHandler() });
    while (leftover) leftover = await processOneJob({ handler: createMockHandler() });

    const job = await createComponentTemplateJob(siteId, ['faq', 'expand-content'], { requestedBy: null, pageUrl: 'https://example.com/faq' });
    assert.equal(job.kind, 'design_generate');
    assert.equal(job.status, 'queued');
    assert.equal(job.recommendation_id, null);
    assert.deepEqual(job.params, { mode: 'component-templates', componentKeys: ['faq', 'expand-content'], pageUrl: 'https://example.com/faq' });

    const handler = createDesignAgentHandler({
      pythonBin: process.execPath,
      scriptPath: path.join(testSupportDir, 'fake-design-task-component-templates.js'),
      dockerBin: path.join(testSupportDir, 'fake-docker.js'),
      getSiteByIdFn: async (id) => { assert.equal(id, siteId); return { id: siteId, repo_owner: 'acme', repo_name: 'site' }; },
      checkoutRepoTarballFn: async () => {}, // no real GitHub call in this suite
    });
    const outcome = await processOneJob({ handler });
    assert.equal(outcome.jobId, job.id);
    assert.equal(outcome.status, 'completed');

    const { rows } = await query('SELECT status, params, result FROM execution_jobs WHERE id = $1', [job.id]);
    assert.equal(rows[0].status, 'completed');
    assert.deepEqual(rows[0].params, { mode: 'component-templates', componentKeys: ['faq', 'expand-content'], pageUrl: 'https://example.com/faq' });
    assert.deepEqual(Object.keys(rows[0].result.componentTemplates).sort(), ['expand-content', 'faq']);
  });
});
