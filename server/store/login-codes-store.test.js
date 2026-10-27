import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const resolve = (p) => fileURLToPath(new URL(p, import.meta.url));

// A tiny in-memory login_codes table that answers exactly the statements the store issues.
let rows; let nextId;
const live = (r) => !r.consumed_at && r.expires_at > Date.now();
mock.module(resolve('../db.js'), { namedExports: { query: async (sql, p) => {
  if (sql.includes('COUNT(*) FILTER')) {
    const mine = rows.filter((r) => r.email === p[0]);
    const lasthour = mine.filter((r) => r.created_at > Date.now() - 3600e3).length;
    const last = mine.length ? Math.max(...mine.map((r) => r.created_at)) : null;
    return { rows: [{ lasthour, since: last ? (Date.now() - last) / 1000 : 1e9 }] };
  }
  if (sql.startsWith('INSERT INTO login_codes')) {
    rows.push({ id: nextId++, email: p[0], code_hash: p[1], attempts: 0, consumed_at: null, created_at: Date.now() - (globalThis.__age || 0), expires_at: Date.now() + 600e3 });
    return { rowCount: 1, rows: [] };
  }
  if (sql.includes('SELECT id, code_hash')) {
    const max = p[1];
    return { rows: rows.filter((r) => r.email === p[0] && live(r) && r.attempts < max).sort((a, b) => b.created_at - a.created_at).slice(0, p[2]).map(({ id, code_hash }) => ({ id, code_hash })) };
  }
  if (sql.includes('SET attempts = attempts + 1')) {
    const r = rows.find((x) => x.id === p[0]);
    if (!r || r.consumed_at || r.attempts >= p[1]) return { rowCount: 0, rows: [] };
    r.attempts += 1;
    return { rowCount: 1, rows: [{ attempts: r.attempts }] };
  }
  if (sql.includes('SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL')) {
    const r = rows.find((x) => x.id === p[0]);
    if (!r || r.consumed_at) return { rowCount: 0, rows: [] };
    r.consumed_at = Date.now(); return { rowCount: 1, rows: [{ id: r.id }] };
  }
  throw new Error(`unexpected SQL: ${sql}`);
} } });

const { issueLoginCode, checkLoginCode, MAX_ATTEMPTS } = await import('./login-codes.js');
beforeEach(() => { rows = []; nextId = 1; globalThis.__age = 0; });

describe('checkLoginCode', () => {
  test('the right code signs in once', async () => {
    const { code } = await issueLoginCode('a@b.test');
    assert.deepEqual(await checkLoginCode('a@b.test', code), { ok: true });
    assert.equal((await checkLoginCode('a@b.test', code)).ok, false, 'a used code is spent');
  });
  test('parallel wrong guesses cannot get past the attempt limit, and the right code then no longer works', async () => {
    const { code } = await issueLoginCode('a@b.test');
    const wrong = code === '000000' ? '111111' : '000000';
    await Promise.all(Array.from({ length: 40 }, () => checkLoginCode('a@b.test', wrong)));
    assert.equal(rows[0].attempts, MAX_ATTEMPTS, 'counted exactly the allowed number, however many ran at once');
    assert.equal((await checkLoginCode('a@b.test', code)).ok, false);
  });
  test('two simultaneous correct submissions cannot both sign in', async () => {
    const { code } = await issueLoginCode('a@b.test');
    const results = await Promise.all([checkLoginCode('a@b.test', code), checkLoginCode('a@b.test', code)]);
    assert.equal(results.filter((r) => r.ok).length, 1);
  });
  test('the last allowed try can still be the right one', async () => {
    const { code } = await issueLoginCode('a@b.test');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) await checkLoginCode('a@b.test', wrong);
    assert.deepEqual(await checkLoginCode('a@b.test', code), { ok: true });
  });
  test('a code for another address never matches', async () => {
    const { code } = await issueLoginCode('a@b.test');
    assert.equal((await checkLoginCode('other@b.test', code)).ok, false);
  });
});

describe('issueLoginCode', () => {
  test("asking for a code for someone else's address does not cancel the code they already have", async () => {
    const first = await issueLoginCode('victim@b.test');
    rows[0].created_at -= 120e3; // past the one-minute spacing
    const second = await issueLoginCode('victim@b.test');
    assert.ok(second.code);
    assert.deepEqual(await checkLoginCode('victim@b.test', first.code), { ok: true }, 'the earlier code still works');
  });
  test('asking again too soon makes nothing', async () => {
    await issueLoginCode('a@b.test');
    assert.deepEqual(await issueLoginCode('a@b.test'), { tooSoon: true });
    assert.equal(rows.length, 1);
  });
});
