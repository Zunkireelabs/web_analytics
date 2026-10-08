import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { requeueProfileForRepeatedBlocks, REQUEUE_AFTER_BLOCKS } from './design-block-repair.js';

const site = { id: 7, repo_owner: 'o', repo_name: 'r' };
const base = (over = {}) => {
  const enqueued = [];
  return { enqueued, deps: {
    countBlocks: async () => REQUEUE_AFTER_BLOCKS, findQueued: async () => null, findLatestJob: async () => null,
    enqueue: async (id, o) => { enqueued.push([id, o]); }, resolvePageUrl: () => 'https://a.com', ...over,
  } };
};

describe('requeueProfileForRepeatedBlocks', () => {
  test('queues one re-derivation when repairable blocks repeat', async () => {
    const b = base();
    assert.deepEqual(await requeueProfileForRepeatedBlocks(site, b.deps), { queued: true, reason: 'repeated-repairable-blocks' });
    assert.deepEqual(b.enqueued, [[7, { requestedBy: null, pageUrl: 'https://a.com' }]]);
  });
  test('a single block is not enough', async () => {
    const b = base({ countBlocks: async () => 1 });
    assert.equal((await requeueProfileForRepeatedBlocks(site, b.deps)).reason, 'not-repeated');
    assert.equal(b.enqueued.length, 0);
  });
  test('never queues a second job while one is waiting', async () => {
    const b = base({ findQueued: async () => ({ id: 1 }) });
    assert.equal((await requeueProfileForRepeatedBlocks(site, b.deps)).reason, 'already-queued');
  });
  test('respects the cooldown since the last derivation', async () => {
    const now = new Date('2026-10-08T00:00:00Z');
    const b = base({ findLatestJob: async () => ({ created_at: '2026-10-07T00:00:00Z' }) });
    assert.equal((await requeueProfileForRepeatedBlocks(site, b.deps, now)).reason, 'cooldown');
    const old = base({ findLatestJob: async () => ({ created_at: '2026-10-01T00:00:00Z' }) });
    assert.equal((await requeueProfileForRepeatedBlocks(site, old.deps, now)).queued, true);
  });
  test('needs a connected repo and a page url; any failure is swallowed', async () => {
    assert.equal((await requeueProfileForRepeatedBlocks({ id: 7 }, base().deps)).reason, 'no-repo');
    assert.equal((await requeueProfileForRepeatedBlocks(site, base({ resolvePageUrl: () => null }).deps)).reason, 'no-page-url');
    assert.equal((await requeueProfileForRepeatedBlocks(site, base({ countBlocks: async () => { throw new Error('x'); } }).deps)).reason, 'error');
  });
});
