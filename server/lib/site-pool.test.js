import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSitesConcurrently } from './site-pool.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (n, key = (i) => `k${i}`) => Array.from({ length: n }, (_, i) => ({ id: i + 1, key: key(i) }));

test('runs up to the limit at once and finishes everything, in the order given', async () => {
  let running = 0; let peak = 0; const started = [];
  await runSitesConcurrently({ sites: mk(7), concurrency: 3, keyOf: (s) => s.key, processSite: async (s) => { started.push(s.id); running++; peak = Math.max(peak, running); await sleep(15); running--; } });
  assert.equal(peak, 3);
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7]);
});

test('concurrency 1 is exactly the old one-after-another order', async () => {
  let running = 0; let peak = 0;
  await runSitesConcurrently({ sites: mk(4), concurrency: 1, processSite: async () => { running++; peak = Math.max(peak, running); await sleep(5); running--; } });
  assert.equal(peak, 1);
});

test('projects sharing one credential never run together; another project with a free credential goes first', async () => {
  const sites = [{ id: 1, key: 'A' }, { id: 2, key: 'A' }, { id: 3, key: 'B' }];
  const live = new Set(); const clashes = []; const order = [];
  await runSitesConcurrently({ sites, concurrency: 3, keyOf: (s) => s.key, processSite: async (s) => {
    for (const o of live) if (o.key === s.key) clashes.push([o.id, s.id]);
    live.add(s); order.push(s.id); await sleep(20); live.delete(s);
  } });
  assert.deepEqual(clashes, []);
  assert.deepEqual(order, [1, 3, 2]); // 3 jumped the queue while 2 waited for the shared credential
});

test('a halt stops new starts, lets running work finish, and reports exactly the ones never started, once', async () => {
  let closed = false; const done = []; const reports = [];
  await runSitesConcurrently({
    sites: mk(6), concurrency: 2, halt: () => (closed ? 'window' : null),
    processSite: async (s) => { await sleep(10); done.push(s.id); if (s.id === 2) closed = true; },
    onHalt: async (reason, notStarted) => reports.push([reason, notStarted.map((s) => s.id)]),
  });
  assert.equal(reports.length, 1);
  assert.equal(reports[0][0], 'window');
  assert.deepEqual([...done, ...reports[0][1]].sort(), [1, 2, 3, 4, 5, 6]); // every project is either run or reported, none twice
  assert.ok(reports[0][1].length > 0);
});

test('one project failing does not stop the others', async () => {
  const errors = []; const done = [];
  await runSitesConcurrently({ sites: mk(4), concurrency: 2, processSite: async (s) => { if (s.id === 2) throw new Error('boom'); done.push(s.id); }, onError: (s, e) => errors.push([s.id, e.message]) });
  assert.deepEqual(errors, [[2, 'boom']]);
  assert.deepEqual(done.sort(), [1, 3, 4]);
});
