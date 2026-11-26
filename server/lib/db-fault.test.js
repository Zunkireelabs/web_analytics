// DATABASE FAULT INJECTION against the throwaway database (srtest on the local container only): the connection is killed while the app is running.
// Found 2026-11-25: with no listener on the pool, the database dropping an idle connection killed the whole process ("Unhandled 'error' event"). These tests
// run a real child process so a crash would be seen as a crash, kill its connections from outside, and check what was recorded is still there.
// Skipped unless DATABASE_URL points at the local srtest database (DB_SSL=off too).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const URL_OK = /@(localhost|127\.0\.0\.1):55432\/srtest/.test(process.env.DATABASE_URL || '');
const ROOT = resolve(import.meta.dirname, '../..');

const CHILD = `
import { query, pool } from '${ROOT}/server/db.js';
import { recordRunIntoCycle, closeDeliveryDay, getOrOpenCycle } from '${ROOT}/server/lib/delivery-cycle.js';
const TZ = 'Asia/Kathmandu', NOW = new Date('2026-11-25T08:00:00Z');
const { rows: [site] } = await query('SELECT id FROM sites ORDER BY id LIMIT 1');
await query("DELETE FROM delivery_cycles WHERE site_id = $1 AND cycle_date = '2026-11-25'", [site.id]);
await recordRunIntoCycle(site.id, { attempted: 3, shipped: 0, failed: 3, selection: {} }, { timezone: TZ, now: NOW });
console.log('FIRST_RECORDED');
await new Promise((r) => setTimeout(r, 3000));            // the parent kills every connection now
// A query that lands on a dead connection may fail once; the work must resume on the next try, and the earlier record must be intact.
let second = null;
for (let i = 0; i < 3 && second === null; i++) second = await recordRunIntoCycle(site.id, { attempted: 2, shipped: 1, prUrl: 'https://x/pull/1', selection: {} }, { timezone: TZ, now: NOW });
const out = await closeDeliveryDay({ sites: [{ id: site.id, timezone: 'Asia/Kolkata' }], timezone: TZ, now: new Date('2026-11-25T11:30:00Z') });
const { rows: [c] } = await query("SELECT passes, attempted, shipped, pr_url, status, closed_at FROM delivery_cycles WHERE site_id = $1 AND cycle_date = '2026-11-25'", [site.id]);
console.log('RESULT ' + JSON.stringify({ passes: c.passes, attempted: c.attempted, shipped: c.shipped, pr: c.pr_url, status: c.status, closed: !!c.closed_at, closeOut: out[0].status }));
await query("DELETE FROM delivery_cycles WHERE site_id = $1 AND cycle_date = '2026-11-25'", [site.id]);
await pool.end();
`;

describe('database faults against the real database', { skip: !URL_OK }, () => {
  test('connections killed mid-sequence: the process survives, what was recorded stays, recording resumes, the day still closes', async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], { env: { ...process.env, DB_SSL: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((r) => child.on('exit', (code) => r(code)));
    for (let i = 0; i < 100 && !out.includes('FIRST_RECORDED'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(out.includes('FIRST_RECORDED'), `the child never recorded the first run:\n${out}`);
    const pg = (await import('pg')).default;
    const killer = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 1 });
    try { await killer.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'srtest' AND pid <> pg_backend_pid()`); } finally { await killer.end(); }
    const code = await exited;
    assert.equal(code, 0, `the process must survive a dropped connection (exit ${code}):\n${out.slice(0, 600)}`);
    const result = JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));
    assert.deepEqual([result.passes, result.attempted, result.shipped, result.pr], [2, 5, 1, 'https://x/pull/1'], 'both runs counted: the first was not lost, the second was not dropped');
    assert.equal(result.closed, true); assert.equal(result.status, 'delivered');
    assert.match(out, /an idle database connection was dropped/, 'the drop was reported, not silent');
  });
});
