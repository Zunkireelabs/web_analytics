import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../db.js';
import {
  enqueue, listByState, getQueueItem, claimForPreparation, markPrepared,
  claimForShipping, markShipped, releaseItem, markSuperseded, releaseStaleClaims,
  countShippedToday, countShippedTodayAllSites, listInFlightBatchItems, dedupeKeyFor, QUEUE_STATES,
} from './shipping-queue.js';

// Integration coverage against the real DB (migration 148/149), same
// convention as store/execution-jobs.test.js — one throwaway site per test,
// torn down here. What's under test is the state machine and its concurrency
// guarantees (partial unique index, FOR UPDATE SKIP LOCKED), which only a
// real database can actually prove.
const siteIds = [];

async function makeSite() {
  const stamp = `test-shipping-queue-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('shipping-queue.test.js fixture', $1, $2, 'UTC')
     RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}

after(async () => {
  if (siteIds.length) await query('DELETE FROM shipping_queue WHERE site_id = ANY($1::int[])', [siteIds]);
  if (siteIds.length) await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
});

describe('enqueue — idempotent per (site, dedupe key), rejects uncounted sources', () => {
  test('a real finding id dedupes across repeated calls, active states only', async () => {
    const siteId = await makeSite();
    const first = await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'f-1' });
    const second = await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'f-1' });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.row.id, first.row.id, 'the same intent enqueued twice returns the same row, not a duplicate');

    const { rows: countRows } = await query('SELECT COUNT(*)::int AS n FROM shipping_queue WHERE site_id = $1', [siteId]);
    assert.equal(countRows[0].n, 1);
  });

  test('a source not in AUTONOMOUS_DRAFT_SOURCES is refused — never silently uncounted', async () => {
    const siteId = await makeSite();
    await assert.rejects(
      enqueue(siteId, { source: 'some-new-lane-nobody-registered', generatorId: 'alt-text', findingId: 'f-2' }),
      /not an autonomous shipping source/,
    );
  });

  test('once shipped, the same finding id can be enqueued again (a genuinely new day\'s detection)', async () => {
    const siteId = await makeSite();
    const { row } = await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'f-3' });
    await markShipped(row.id);

    const { created, row: row2 } = await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'f-3' });
    assert.equal(created, true);
    assert.notEqual(row2.id, row.id);
  });

  test('no findingId falls back to a stable hash of (kind, generatorId, params) — same call twice still dedupes', async () => {
    const siteId = await makeSite();
    const opts = { source: 'content-repair', kind: 'file-edits', params: { edits: [{ path: 'a.njk', content: 'x' }] } };
    const first = await enqueue(siteId, opts);
    const second = await enqueue(siteId, opts);
    assert.equal(second.created, false);
    assert.equal(second.row.id, first.row.id);
  });

  test('memoryRefId is stored distinct from params', async () => {
    const siteId = await makeSite();
    const { row } = await enqueue(siteId, { source: 'learned-repair', generatorId: 'alt-text', findingId: 'f-4', params: { page: '/x' }, memoryRefId: 99 });
    assert.equal(Number(row.memory_ref_id), 99);
    assert.deepEqual(row.params, { page: '/x' });
  });
});

describe('claimForPreparation — FOR UPDATE SKIP LOCKED prevents double-claiming', () => {
  test('two concurrent claims for the same site never return overlapping rows', async () => {
    const siteId = await makeSite();
    for (let i = 0; i < 6; i++) {
      await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: `race-${i}` });
    }

    const [batchA, batchB] = await Promise.all([
      claimForPreparation(siteId, { limit: 3, workerId: 'worker-a' }),
      claimForPreparation(siteId, { limit: 3, workerId: 'worker-b' }),
    ]);

    const idsA = new Set(batchA.map((r) => r.id));
    const idsB = new Set(batchB.map((r) => r.id));
    const overlap = [...idsA].filter((id) => idsB.has(id));
    assert.deepEqual(overlap, [], 'no row claimed by both workers');
    assert.equal(idsA.size + idsB.size, 6, 'together every row was claimed exactly once');
    for (const row of [...batchA, ...batchB]) {
      assert.equal(row.state, QUEUE_STATES.PREPARING);
      assert.equal(row.claimed_by, idsA.has(row.id) ? 'worker-a' : 'worker-b');
    }
  });

  test('claiming only ever pulls from queued, never from prepared/shipping/shipped', async () => {
    const siteId = await makeSite();
    const { row } = await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'already-prepared' });
    await markPrepared(row.id, { draftId: 7, filePaths: ['a.njk'] });

    const claimed = await claimForPreparation(siteId, { limit: 10 });
    assert.deepEqual(claimed, []);
  });
});

describe('markPrepared / claimForShipping / markShipped — the happy path to one batch', () => {
  test('a prepared item is claimed into a batch and marked shipped once the PR is confirmed open', async () => {
    const siteId = await makeSite();
    const { row } = await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'ship-1' });
    const prepared = await markPrepared(row.id, { draftId: 42, filePaths: ['src/a.njk'], score: 500 });
    assert.equal(prepared.state, QUEUE_STATES.PREPARED);
    assert.equal(Number(prepared.draft_id), 42);
    assert.deepEqual(prepared.file_paths, ['src/a.njk']);

    const claimed = await claimForShipping(siteId, [row.id], 'batch-2026-09-08');
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].state, QUEUE_STATES.SHIPPING);
    assert.equal(claimed[0].batch_id, 'batch-2026-09-08');

    const shipped = await markShipped(row.id);
    assert.equal(shipped.state, QUEUE_STATES.SHIPPED);
    assert.ok(shipped.shipped_at);

    const stillQueued = await listByState(siteId, QUEUE_STATES.QUEUED);
    assert.deepEqual(stillQueued, []);
  });

  test('markPrepared refuses to downgrade an already-shipped row', async () => {
    const siteId = await makeSite();
    const { row } = await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'ship-2' });
    await markPrepared(row.id, { draftId: 1, filePaths: [] });
    await markShipped(row.id);

    const result = await markPrepared(row.id, { draftId: 999, filePaths: ['should-not-apply.njk'] });
    assert.equal(result, null, 'a shipped row must never be silently reopened by a duplicate preparation pass');
    const still = await getQueueItem(row.id);
    assert.equal(still.state, QUEUE_STATES.SHIPPED);
    assert.equal(Number(still.draft_id), 1);
  });
});

describe('releaseItem — retryable vs terminal', () => {
  test('retryable with an existing draft returns to prepared, keeping the draft (no regeneration)', async () => {
    const siteId = await makeSite();
    const { row } = await enqueue(siteId, { source: 'learned-repair', generatorId: 'alt-text', findingId: 'release-1' });
    await markPrepared(row.id, { draftId: 5, filePaths: [] });
    await claimForShipping(siteId, [row.id], 'batch-x');

    const released = await releaseItem(row.id, { retryable: true, error: 'GitHub rate limited' });
    assert.equal(released.state, QUEUE_STATES.PREPARED, 'a transient batch failure keeps the already-generated draft, ready to ship next run');
    assert.equal(Number(released.draft_id), 5);
    assert.equal(released.batch_id, null);
    assert.equal(released.last_error, 'GitHub rate limited');
  });

  test('retryable with NO draft yet returns to queued for another preparation attempt', async () => {
    const siteId = await makeSite();
    const { row } = await enqueue(siteId, { source: 'learned-repair', generatorId: 'alt-text', findingId: 'release-2' });
    await claimForPreparation(siteId, { limit: 10 });

    const released = await releaseItem(row.id, { retryable: true, error: 'db blip' });
    assert.equal(released.state, QUEUE_STATES.QUEUED);
  });

  test('non-retryable goes to failed, terminal for this attempt', async () => {
    const siteId = await makeSite();
    const { row } = await enqueue(siteId, { source: 'learned-repair', generatorId: 'alt-text', findingId: 'release-3' });
    const released = await releaseItem(row.id, { retryable: false, error: 'generator refused' });
    assert.equal(released.state, QUEUE_STATES.FAILED);
  });

  test('releasing an already-shipped row is a safe no-op', async () => {
    const siteId = await makeSite();
    const { row } = await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'release-4' });
    await markPrepared(row.id, { draftId: 1, filePaths: [] });
    await markShipped(row.id);

    const result = await releaseItem(row.id, { retryable: true });
    assert.equal(result, null);
    const still = await getQueueItem(row.id);
    assert.equal(still.state, QUEUE_STATES.SHIPPED);
  });
});

describe('releaseStaleClaims — restart safety', () => {
  test('a preparing row with no draft, claimed long ago, returns to queued', async () => {
    const siteId = await makeSite();
    const { row } = await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'stale-1' });
    await claimForPreparation(siteId, { limit: 10 });
    await query(`UPDATE shipping_queue SET claimed_at = now() - interval '3 hours' WHERE id = $1`, [row.id]);

    const released = await releaseStaleClaims({ olderThanMinutes: 90 });
    assert.ok(released.some((r) => r.id === row.id));
    const still = await getQueueItem(row.id);
    assert.equal(still.state, QUEUE_STATES.QUEUED);
    assert.equal(still.claimed_at, null);
  });

  test('a shipping row whose worker died, WITH a draft, returns to prepared — never regenerated', async () => {
    const siteId = await makeSite();
    const { row } = await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'stale-2' });
    await markPrepared(row.id, { draftId: 77, filePaths: ['x.njk'] });
    await claimForShipping(siteId, [row.id], 'dead-batch');
    await query(`UPDATE shipping_queue SET claimed_at = now() - interval '3 hours' WHERE id = $1`, [row.id]);

    const released = await releaseStaleClaims({ olderThanMinutes: 90 });
    assert.ok(released.some((r) => r.id === row.id));
    const still = await getQueueItem(row.id);
    assert.equal(still.state, QUEUE_STATES.PREPARED, 'resumes at shipping, not regenerated from scratch');
    assert.equal(Number(still.draft_id), 77);
    assert.equal(still.batch_id, null);
  });

  test('a recently-claimed row is left alone', async () => {
    const siteId = await makeSite();
    const { row } = await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'stale-3' });
    await claimForPreparation(siteId, { limit: 10 });

    const released = await releaseStaleClaims({ olderThanMinutes: 90 });
    assert.ok(!released.some((r) => r.id === row.id));
    const still = await getQueueItem(row.id);
    assert.equal(still.state, QUEUE_STATES.PREPARING);
  });
});

describe('countShippedToday / countShippedTodayAllSites — the shared ceiling\'s own counter', () => {
  test('counts only shipped rows, scoped to today, for this site', async () => {
    const siteId = await makeSite();
    const a = await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'count-1' });
    const b = await enqueue(siteId, { source: 'learned-repair', generatorId: 'alt-text', findingId: 'count-2' });
    await enqueue(siteId, { source: 'content-repair', kind: 'file-edits', params: { edits: [{ path: 'z.njk', content: 'z' }] } }); // left queued — never shipped

    await markPrepared(a.row.id, { draftId: 1, filePaths: [] });
    await markShipped(a.row.id);
    await markPrepared(b.row.id, { draftId: 2, filePaths: [] });
    await markShipped(b.row.id);

    const count = await countShippedToday(siteId, 'UTC');
    assert.equal(count, 2, 'both auto-remediation and learned-repair count toward this site\'s shared ceiling');
  });

  test('countShippedTodayAllSites sums across sites', async () => {
    const siteA = await makeSite();
    const siteB = await makeSite();
    const before = await countShippedTodayAllSites();

    const { row: r1 } = await enqueue(siteA, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'global-1' });
    await markPrepared(r1.id, { draftId: 1, filePaths: [] });
    await markShipped(r1.id);
    const { row: r2 } = await enqueue(siteB, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'global-2' });
    await markPrepared(r2.id, { draftId: 2, filePaths: [] });
    await markShipped(r2.id);

    const after = await countShippedTodayAllSites();
    assert.equal(after, before + 2);
  });
});

describe('listInFlightBatchItems — the recovery entry point', () => {
  test('finds items claimed by a batch that never finished', async () => {
    const siteId = await makeSite();
    const { row } = await enqueue(siteId, { source: 'auto-remediation', generatorId: 'alt-text', findingId: 'inflight-1' });
    await markPrepared(row.id, { draftId: 1, filePaths: [] });
    await claimForShipping(siteId, [row.id], 'stranded-batch');

    const items = await listInFlightBatchItems(siteId, 'stranded-batch');
    assert.equal(items.length, 1);
    assert.equal(items[0].id, row.id);
  });
});

describe('dedupeKeyFor', () => {
  test('a finding id always wins over the params hash', () => {
    assert.equal(dedupeKeyFor({ source: 'x', generatorId: 'g', findingId: 'f-1', params: { a: 1 } }), 'finding:f-1');
  });

  test('no finding id hashes kind+generator+params, stable across identical calls', () => {
    const a = dedupeKeyFor({ source: 'content-repair', kind: 'file-edits', params: { edits: [1, 2] } });
    const b = dedupeKeyFor({ source: 'content-repair', kind: 'file-edits', params: { edits: [1, 2] } });
    assert.equal(a, b);
  });

  test('different params hash differently', () => {
    const a = dedupeKeyFor({ kind: 'file-edits', params: { edits: [1] } });
    const b = dedupeKeyFor({ kind: 'file-edits', params: { edits: [2] } });
    assert.notEqual(a, b);
  });
});
