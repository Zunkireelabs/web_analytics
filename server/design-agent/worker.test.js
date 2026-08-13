import { test, describe, after } from 'node:test';
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
// this suite creates is scoped to throwaway sites and torn down in `after`,
// so it never leaves rows behind in the shared DB.

// One throwaway site PER TEST, not per file.
//
// Job claiming is site-scoped (claimNextDesignAgentJob(siteId)), so a private
// site makes cross-test contention structurally impossible rather than merely
// tolerated. It has to be per-test because node:test runs the subtests in this
// file CONCURRENTLY: the concurrency case below spawns two drain loops that
// claim every queued job for their site until the queue is empty, so on a
// shared site it would routinely swallow the polling case's two jobs before
// that worker's 10ms poll could reach them — which is exactly the flake this
// replaces ("waitFor: condition not met before timeout", after all 5 retries).
const siteIds = [];
const recIds = [];

let recSeq = 0;

async function makeSite() {
  const stamp = `test-worker-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('design-agent-worker.test.js fixture', $1, $2, 'UTC')
     RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}

async function makeRecommendation(siteId) {
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

async function makeQueuedJob(siteId) {
  const recommendationId = await makeRecommendation(siteId);
  return createDesignAgentJob(siteId, recommendationId, { requestedBy: null });
}



after(async () => {
  if (siteIds.length) await query('DELETE FROM execution_jobs WHERE site_id = ANY($1::int[])', [siteIds]);
  if (recIds.length) await query('DELETE FROM recommendations WHERE id = ANY($1::int[])', [recIds]);
  if (siteIds.length) await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  await pool.end();
});

// Every test below that creates exactly one fixture job and immediately
// calls processOneJob/starts a worker expecting to be the one that claims
// it is vulnerable to the same real, reproduced-in-development race: a
// genuinely separate, already-running process can claim any 'queued'
// design_generate row via claimNextDesignAgentJob's unscoped default,
// regardless of the siteId this test itself passes to its OWN claim calls
// (siteId only restricts what THIS test's calls can see, not what anyone
// else's can). When that happens the job still reaches a terminal state —
// just via somebody else's handler, not this test's own — which is exactly
// what distinguishes it from a genuine bug: a real regression leaves the
// job stuck 'queued'/'executing' forever, an external steal completes it.
// retryUnlessStolen re-runs the whole scenario with a fresh job when, and
// only when, it detects that specific signature, so a rare coincidence
// never fails the suite while an actual regression still does, immediately,
// on the first attempt.
//
// The steal check itself has to POLL, not read once: SKIP LOCKED makes this
// test's own claim attempt see the row as unavailable (and fail) the moment
// the external claimant's transaction takes its row lock, which can be
// BEFORE that transaction actually commits its status update — a bare
// single read right after the failure can still observe 'queued' for a
// genuinely-being-stolen row, misclassifying a real steal as "stuck" and
// surfacing a false failure instead of retrying.
async function retryUnlessStolen(jobIdRef, fn, { attempts = 5 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const jobId = jobIdRef.current;
      const isLastAttempt = attempt === attempts;
      if (isLastAttempt || !jobId) throw err;
      let stolen = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const { rows } = await query('SELECT status FROM execution_jobs WHERE id = $1', [jobId]);
        if (rows[0] && ['completed', 'failed'].includes(rows[0].status)) { stolen = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!stolen) throw err; // genuinely stuck — a real bug, surface it now
      // else: confirmed steal signature (terminal state reached, but never via this test's own worker) — retry with a fresh job
    }
  }
}

describe('processOneJob — single-job lifecycle', () => {
  test('returns null when the queue is empty', async () => {
    // A freshly-created site has an empty queue by construction, so this needs
    // no drain-the-leftovers preamble any more — that only existed because
    // every test used to share one site and could inherit another's fixtures.
    const siteId = await makeSite();
    assert.equal(await processOneJob({ handler: createMockHandler(), siteId }), null);
  });

  test('claims a queued job, transitions to executing then completed, and logs both', async () => {
    const siteId = await makeSite();
    const jobIdRef = { current: null };
    await retryUnlessStolen(jobIdRef, async () => {
      const job = await makeQueuedJob(siteId);
      jobIdRef.current = job.id;
      const result = await processOneJob({ handler: createMockHandler(), siteId });
      assert.ok(result, 'job was claimed by somebody else before this test\'s own call — see retryUnlessStolen');
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
  });

  test('a throwing handler leaves the job failed, not stuck executing', async () => {
    const siteId = await makeSite();
    const jobIdRef = { current: null };
    await retryUnlessStolen(jobIdRef, async () => {
      const job = await makeQueuedJob(siteId);
      jobIdRef.current = job.id;
      const result = await processOneJob({ handler: createMockHandler({ shouldFail: true }), siteId });
      assert.ok(result, 'job was claimed by somebody else before this test\'s own call — see retryUnlessStolen');
      assert.equal(result.jobId, job.id);
      assert.equal(result.status, 'failed');

      const { rows } = await query('SELECT status, finished_at, logs FROM execution_jobs WHERE id = $1', [job.id]);
      assert.equal(rows[0].status, 'failed');
      assert.ok(rows[0].finished_at);
      assert.ok(rows[0].logs.map((l) => l.message).some((m) => m.includes('Job failed')));
    });
  });

  test('default handler (no OpenHands yet) fails the job with a clear "not implemented" message', async () => {
    const siteId = await makeSite();
    const jobIdRef = { current: null };
    await retryUnlessStolen(jobIdRef, async () => {
      const job = await makeQueuedJob(siteId);
      jobIdRef.current = job.id;
      const result = await processOneJob({ siteId });
      assert.ok(result, 'job was claimed by somebody else before this test\'s own call — see retryUnlessStolen');
      assert.equal(result.jobId, job.id);
      assert.equal(result.status, 'failed');
      assert.match(result.error, /not implemented/i);
    });
  });
});

describe('concurrency — two workers racing the same queue', () => {
  // claimNextDesignAgentJob(siteId) below scopes THIS test's own two
  // drain() loops to only ever claim rows belonging to this test's own
  // throwaway site — verified directly (a scoped claim against a two-site
  // fixture claims only its own site's row, never the other's, and a
  // second scoped claim on a drained site correctly returns null). That
  // closes the most likely local cause of collision (a leftover queued row
  // from a different test run's own fixture) and is generally good
  // practice regardless.
  //
  // It does NOT fully close the loop: claimNextDesignAgentJob's default
  // (no siteId) is deliberately unscoped — real worker.js deployments poll
  // globally across every tenant, by design — and reproduction during
  // development of this suite showed a genuinely separate, already-running
  // process (its own claim log line reads "Claimed by worker pid 1", never
  // this test process's own pid) can still claim one of these 8 fixture
  // jobs mid-race, using that same unscoped default, regardless of what
  // siteId THIS test passes. When that happens the stolen job still
  // reaches a terminal status (its handler has no real repo/site to work
  // with, so it fails) — never left stranded, just processed by somebody
  // other than A or B.
  //
  // So this test cannot assert "A and B between them process exactly 8" —
  // only that SKIP LOCKED's real guarantee holds (no job this test created
  // is ever claimed twice, by A, by B, or by anyone else) and that every
  // job reaches a terminal state, never stuck in 'queued'/'executing'.
  test('no job is claimed more than once by this test\'s own workers, and every job reaches a terminal state', async () => {
    const siteId = await makeSite();
    const jobs = await Promise.all(Array.from({ length: 8 }, () => makeQueuedJob(siteId)));
    const claimedBy = new Map(); // jobId -> count of handler invocations

    const onRun = (job) => claimedBy.set(job.id, (claimedBy.get(job.id) || 0) + 1);
    const handlerA = createMockHandler({ delayMs: 30, onRun });
    const handlerB = createMockHandler({ delayMs: 30, onRun });

    // Two independent worker instances (standing in for two OS processes —
    // they share nothing but the DB, exactly like two real `node worker.js`
    // invocations would) both draining the same queue concurrently.
    async function drain(handler) {
      let processed = 0;
      let result = await processOneJob({ handler, siteId });
      while (result) {
        processed++;
        result = await processOneJob({ handler, siteId });
      }
      return processed;
    }

    const [countA, countB] = await Promise.all([drain(handlerA), drain(handlerB)]);

    assert.equal(claimedBy.size, countA + countB, 'every job this test\'s own handlers ran should be counted exactly once');
    for (const [jobId, count] of claimedBy) {
      assert.equal(count, 1, `job ${jobId} was claimed more than once by this test's own workers`);
    }

    const { rows } = await query(
      'SELECT id, status FROM execution_jobs WHERE id = ANY($1::int[])',
      [jobs.map((j) => j.id)]
    );
    const stuck = rows.filter((r) => r.status !== 'completed' && r.status !== 'failed');
    assert.deepEqual(stuck, [], 'no job should be left in queued/executing — every job must reach a terminal state, however it was claimed');
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

// Keeps at least one job queued for `siteId` until this test's own worker has
// claimed `target` of them, then stops.
//
// This exists because of a REAL, reproduced external claimant, not a
// hypothetical one: claimNextDesignAgentJob's siteId argument only narrows what
// the CALLER can see, so a separately-deployed worker polling the same database
// with the unscoped default claims any queued design_generate row, on any site,
// including the fixtures created here. Confirmed from the stolen jobs' own log
// lines — "Claimed by worker pid 1", a containerised worker, while this suite's
// process had a different pid.
//
// A fixed two-job fixture therefore could not be made reliable by any amount of
// site isolation or timeout tuning: when the thief took one, this test's worker
// had nothing left to claim and waited out the clock. Topping the queue back up
// converges instead — every steal simply costs one more round — while the
// property under test (the worker never starts a claim while its own previous
// handler is still running) is asserted exactly as strictly as before.
function keepQueueTopped(siteId, isDone) {
  let stop = false;
  const finished = (async () => {
    while (!stop && !isDone()) {
      const { rows } = await query(
        `SELECT count(*)::int AS queued FROM execution_jobs
          WHERE site_id = $1 AND kind = 'design_generate' AND status = 'queued'`,
        [siteId]
      );
      if (!rows[0].queued) await makeQueuedJob(siteId);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  return async () => { stop = true; await finished; };
}

describe('createWorker — polling lifecycle', () => {
  test('prevents overlapping polls: a slow job blocks the next poll until it settles', async () => {
    const siteId = await makeSite();
    {
      const polls = []; // { at, claimedJob }
      const handlerDelayMs = 500; // well above real network jitter for one round-trip
      const claimedCount = () => polls.filter((p) => p.claimedJob).length;
      const worker = createWorker({
        pollIntervalMs: 10,
        handler: createMockHandler({ delayMs: handlerDelayMs }),
        onPoll: (result) => polls.push({ at: Date.now(), claimedJob: result !== null }),
        siteId,
      });
      const stopTopping = keepQueueTopped(siteId, () => claimedCount() >= 2);
      try {
        worker.start();
        // Two claims by THIS worker is what the assertion below needs; the
        // top-up loop guarantees there is always something to claim, so this
        // converges regardless of how many jobs the external worker takes.
        await waitFor(() => claimedCount() >= 2, { timeoutMs: 30_000 });
      } finally {
        await stopTopping();
        await worker.stop();
      }

      const jobPolls = polls.filter((p) => p.claimedJob);
      assert.ok(jobPolls.length >= 2, `expected at least 2 claims by this test's own worker, got ${jobPolls.length}`);
      // The gap between the two job-claiming polls' completion times must be
      // at least the handler's own delay — proof the second job's claim never
      // started while the first job's handler was still running (structurally
      // guaranteed by createWorker awaiting currentPoll before re-arming its
      // timer; this is the empirical check).
      const gap = jobPolls[1].at - jobPolls[0].at;
      assert.ok(gap >= handlerDelayMs * 0.8, `second job's poll started too soon after the first settled (gap ${gap}ms)`);
    }
  });

  test('graceful shutdown: stop() waits for the in-flight job, leaves nothing stuck in executing', async () => {
    const siteId = await makeSite();
    const jobIdRef = { current: null };
    await retryUnlessStolen(jobIdRef, async () => {
      const job = await makeQueuedJob(siteId);
      jobIdRef.current = job.id;
      let handlerStarted = false;
      const worker = createWorker({
        pollIntervalMs: 10,
        handler: createMockHandler({ delayMs: 300, onRun: () => { handlerStarted = true; } }),
        siteId,
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
  });

  test('stop() before any job is claimed leaves the queue untouched', async () => {
    const siteId = await makeSite();
    const job = await makeQueuedJob(siteId);
    const worker = createWorker({ pollIntervalMs: 5, handler: createMockHandler({ delayMs: 500 }), siteId });
    // Never started — stop() should be a safe no-op.
    await worker.stop();
    const { rows } = await query('SELECT status FROM execution_jobs WHERE id = $1', [job.id]);
    assert.equal(rows[0].status, 'queued');
  });
});

describe('componentTemplates job — full real-DB lifecycle through the dispatching handler', () => {
  test('createComponentTemplateJob -> claim -> dispatch -> completed, with params and result round-tripping through Postgres JSONB', async () => {
    const siteId = await makeSite();
    const jobIdRef = { current: null };
    await retryUnlessStolen(jobIdRef, async () => {
      const job = await createComponentTemplateJob(siteId, ['faq', 'expand-content'], { requestedBy: null, pageUrl: 'https://example.com/faq' });
      jobIdRef.current = job.id;
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
      const outcome = await processOneJob({ handler, siteId });
      assert.ok(outcome, 'job was claimed by somebody else before this test\'s own call — see retryUnlessStolen');
      assert.equal(outcome.jobId, job.id);
      assert.equal(outcome.status, 'completed');

      const { rows } = await query('SELECT status, params, result FROM execution_jobs WHERE id = $1', [job.id]);
      assert.equal(rows[0].status, 'completed');
      assert.deepEqual(rows[0].params, { mode: 'component-templates', componentKeys: ['faq', 'expand-content'], pageUrl: 'https://example.com/faq' });
      assert.deepEqual(Object.keys(rows[0].result.componentTemplates).sort(), ['expand-content', 'faq']);

      // The point of the whole job: the derived templates are now VERIFIED on
      // the site row, not just sitting on execution_jobs.result where nothing
      // reads them. This is the step that was missing entirely — the queued
      // re-derivation ran, succeeded, and left the site exactly as blocked as
      // before, so an unverified template could never heal on its own.
      const { rows: siteRows } = await query('SELECT url_file_map FROM sites WHERE id = $1', [siteId]);
      const saved = siteRows[0].url_file_map?.siteRoot?.componentTemplates || {};
      assert.deepEqual(Object.keys(saved).sort(), ['expandContent', 'faq'], 'stored under componentTemplates KEYS, not action types');
      for (const key of ['faq', 'expandContent']) {
        assert.equal(saved[key].verifiedBy, 'design-agent');
        assert.ok(saved[key].verifiedAt, `${key} carries a verification timestamp`);
        assert.equal(saved[key].verifiedRef, String(job.id), `${key} points back at the job that derived it`);
      }
    });
  });

  test('a derived template that violates its placeholder contract fails the job instead of being saved', async () => {
    const siteId = await makeSite();

    const jobIdRef = { current: null };
    await retryUnlessStolen(jobIdRef, async () => {
      const job = await createComponentTemplateJob(siteId, ['faq'], { requestedBy: null });
      jobIdRef.current = job.id;

      const outcome = await processOneJob({
        siteId,
        handler: async () => ({ jobId: job.id, componentTemplates: { faq: { wrapper: '<div>{{ROWS}}</div>', row: '<div>no tokens here</div>' } } }),
      });
      assert.ok(outcome, 'job was claimed by somebody else — see retryUnlessStolen');
      assert.equal(outcome.status, 'failed');

      const { rows } = await query('SELECT url_file_map FROM sites WHERE id = $1', [siteId]);
      const storedRow = rows[0].url_file_map?.siteRoot?.componentTemplates?.faq?.row;
      assert.ok(!storedRow?.includes('no tokens here'),
        'the invalid row must not have been written over whatever the site already had');
    });
  });
});
