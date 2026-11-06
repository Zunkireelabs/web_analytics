// Global browser slots against a REAL Postgres, with separate pools standing in for separate workers.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createBrowserSlots, BrowserCapacityError } from './browser-slots.js';

const mkPool = () => new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 4 });
const workerA = mkPool(); const workerB = mkPool(); const workerC = mkPool();
after(async () => { await Promise.all([workerA.end(), workerB.end(), workerC.end()].map((p) => p.catch(() => {}))); });

describe('global browser slots across workers', () => {
  test('2 slots shared by 3 workers: the third waits until one is released', async () => {
    const opts = { slots: 2, waitMs: 3000, pollMs: 20 };
    const a = createBrowserSlots({ ...opts, getPool: async () => workerA });
    const b = createBrowserSlots({ ...opts, getPool: async () => workerB });
    const c = createBrowserSlots({ ...opts, getPool: async () => workerC });
    const relA = await a.acquire(); const relB = await b.acquire();
    let cGot = false;
    const pending = c.acquire().then((rel) => { cGot = true; return rel; });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(cGot, false, 'no third browser while two are running anywhere');
    await relA();
    const relC = await pending;
    assert.equal(cGot, true);
    await relB(); await relC();
  });

  test('a full house times out with a TRANSIENT capacity error (the item is pending, not failed)', async () => {
    const a = createBrowserSlots({ slots: 1, waitMs: 3000, pollMs: 20, getPool: async () => workerA });
    const b = createBrowserSlots({ slots: 1, waitMs: 150, pollMs: 20, getPool: async () => workerB });
    const rel = await a.acquire();
    await assert.rejects(b.acquire(), (e) => e instanceof BrowserCapacityError && e.transient === true);
    await rel();
  });

  test('a worker that CRASHES (its database session dies) frees its slot automatically — no leaked capacity', async () => {
    const crashing = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 1 });
    crashing.on('error', () => {}); // the killed session surfaces here, as it would in the dying worker
    const a = createBrowserSlots({ slots: 1, waitMs: 3000, pollMs: 20, getPool: async () => crashing });
    await a.acquire(); // held, never released: the worker is about to die mid-capture
    const holder = (await workerB.query("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 72001 AND objid = 0 AND granted")).rows[0];
    assert.ok(holder, 'the slot is held by the crashing worker');
    await workerB.query('SELECT pg_terminate_backend($1)', [holder.pid]); // what a process crash does to its session
    const b = createBrowserSlots({ slots: 1, waitMs: 3000, pollMs: 20, getPool: async () => workerB });
    const rel = await b.acquire();
    await rel();
  });

  test('database unavailable -> falls back to a per-process limit instead of stopping browser work', async () => {
    const warns = [];
    const s = createBrowserSlots({ slots: 1, getPool: async () => ({ connect: async () => { throw new Error('ECONNREFUSED'); } }), log: { warn: (m) => warns.push(m) } });
    const r1 = await s.acquire();
    let second = false; const p = s.acquire().then((r) => { second = true; return r; });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(second, false); await r1(); await (await p)();
    assert.equal(warns.length, 1);
  });
});
