import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../db.js';
import { createDesignAgentJob, reclaimStaleExecutingJobs } from './execution-jobs.js';

// Integration coverage against the real DB, same convention as
// design-agent/worker.test.js — one throwaway site per test, torn down here.
const siteIds = [];

async function makeSite() {
  const stamp = `test-execution-jobs-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('execution-jobs.test.js fixture', $1, $2, 'UTC')
     RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}

async function makeExecutingJob(siteId, { startedAgoMs }) {
  const job = await createDesignAgentJob(siteId, null, { params: { mode: 'design-profile', componentKeys: ['__design-profile__'] } });
  await query(
    `UPDATE execution_jobs SET status = 'executing', started_at = now() - ($2::text || ' milliseconds')::interval WHERE id = $1`,
    [job.id, startedAgoMs]
  );
  return job.id;
}

after(async () => {
  if (siteIds.length) await query('DELETE FROM execution_jobs WHERE site_id = ANY($1::int[])', [siteIds]);
  if (siteIds.length) await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
});

describe('reclaimStaleExecutingJobs', () => {
  test('resets a job stuck in "executing" long past its worker\'s dead-process threshold', async () => {
    const siteId = await makeSite();
    const jobId = await makeExecutingJob(siteId, { startedAgoMs: 60 * 60 * 1000 }); // 1h ago — well past any live-process bound

    const reclaimed = await reclaimStaleExecutingJobs({ olderThanMs: 30 * 60 * 1000 });
    assert.ok(reclaimed.some((r) => r.id === jobId), 'the stale job should be among the reclaimed rows');

    const { rows } = await query('SELECT status, started_at FROM execution_jobs WHERE id = $1', [jobId]);
    assert.equal(rows[0].status, 'queued', 'reset to queued, not failed — the run itself may have been fine, only the process hosting it died');
    assert.equal(rows[0].started_at, null, 'cleared so a fresh claim gets a clean started_at');
  });

  test('leaves a recently-started "executing" job alone — it may still be genuinely in flight', async () => {
    const siteId = await makeSite();
    const jobId = await makeExecutingJob(siteId, { startedAgoMs: 60 * 1000 }); // 1 minute ago

    const reclaimed = await reclaimStaleExecutingJobs({ olderThanMs: 30 * 60 * 1000 });
    assert.ok(!reclaimed.some((r) => r.id === jobId), 'must not touch a job that could still be legitimately running');

    const { rows } = await query('SELECT status FROM execution_jobs WHERE id = $1', [jobId]);
    assert.equal(rows[0].status, 'executing');
  });

  test('leaves a "queued" or "completed" job untouched regardless of age', async () => {
    const siteId = await makeSite();
    const queuedJob = await createDesignAgentJob(siteId, null, { params: {} });
    await query(`UPDATE execution_jobs SET created_at = now() - interval '2 hours' WHERE id = $1`, [queuedJob.id]);

    const reclaimed = await reclaimStaleExecutingJobs({ olderThanMs: 1000 });
    assert.ok(!reclaimed.some((r) => r.id === queuedJob.id));
    const { rows } = await query('SELECT status FROM execution_jobs WHERE id = $1', [queuedJob.id]);
    assert.equal(rows[0].status, 'queued');
  });
});
