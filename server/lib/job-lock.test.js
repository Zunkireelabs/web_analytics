import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Fakes job_locks as a single in-memory row keyed by job_key, matching the
// exact three statements job-lock.js issues (acquire, heartbeat, release) —
// same fake-the-DB-by-SQL-shape convention as action-center-reconciler.test.js.
let table;

function fakeQuery(sql, params) {
  const norm = sql.replace(/\s+/g, ' ').trim();
  if (norm.startsWith('INSERT INTO job_locks')) {
    const [jobKey, ownerId] = params;
    const existing = table.get(jobKey);
    if (!existing || existing.expiresAt < Date.now()) {
      table.set(jobKey, { ownerId, expiresAt: Date.now() + 999999 });
      return { rows: [{ owner_id: ownerId }] };
    }
    return { rows: [] };
  }
  if (norm.startsWith('UPDATE job_locks SET heartbeat_at')) {
    const [jobKey, ownerId] = params;
    const row = table.get(jobKey);
    if (row && row.ownerId === ownerId) row.expiresAt = Date.now() + 999999;
    return { rows: [] };
  }
  if (norm.startsWith('DELETE FROM job_locks')) {
    const [jobKey, ownerId] = params;
    const row = table.get(jobKey);
    if (row && row.ownerId === ownerId) table.delete(jobKey);
    return { rows: [] };
  }
  throw new Error(`job-lock.test.js fake query: unhandled SQL shape: ${sql}`);
}

const resolve = (p) => new URL(p, import.meta.url).href;
const { mock } = await import('node:test');
mock.module(resolve('../db.js'), {
  namedExports: { query: (text, params) => fakeQuery(text, params) },
});
const { withJobLock, jobKeyFor } = await import('./job-lock.js');

describe('withJobLock', () => {
  test('runs fn when the lock is free', async () => {
    table = new Map();
    const { ran, result } = await withJobLock('daily-job:all-sites', async () => 'done');
    assert.equal(ran, true);
    assert.equal(result, 'done');
  });

  test('a second concurrent holder is skipped, not queued', async () => {
    table = new Map();
    table.set('daily-job:all-sites', { ownerId: 'other-process:abc', expiresAt: Date.now() + 999999 });
    let called = false;
    const { ran, reason } = await withJobLock('daily-job:all-sites', async () => { called = true; });
    assert.equal(ran, false);
    assert.equal(reason, 'locked');
    assert.equal(called, false, 'fn must not run while another holder has the lease');
  });

  test('an expired lease is reclaimed, not respected', async () => {
    table = new Map();
    table.set('daily-job:all-sites', { ownerId: 'dead-process:xyz', expiresAt: Date.now() - 1000 });
    const { ran } = await withJobLock('daily-job:all-sites', async () => 'recovered');
    assert.equal(ran, true, 'a crashed holder\'s lease must not block the job forever');
  });

  test('the lock is released after fn resolves, so a later call can acquire it', async () => {
    table = new Map();
    await withJobLock('daily-job:all-sites', async () => {});
    const { ran } = await withJobLock('daily-job:all-sites', async () => 'second run');
    assert.equal(ran, true);
  });

  test('the lock is released even when fn throws', async () => {
    table = new Map();
    await assert.rejects(() => withJobLock('daily-job:all-sites', async () => {
      throw new Error('boom');
    }));
    const { ran } = await withJobLock('daily-job:all-sites', async () => 'after failure');
    assert.equal(ran, true, 'a thrown error inside fn must not leave the lease stuck until it expires');
  });

  test('jobKeyFor scopes the lock per job and per site, so two different jobs never contend', async () => {
    assert.equal(jobKeyFor('daily-job', 'all-sites'), 'daily-job:all-sites');
    assert.notEqual(jobKeyFor('daily-job', 'all-sites'), jobKeyFor('auto-remediation-ship', 'all-sites'));
  });
});
