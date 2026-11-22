import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strictExports } from './strict-exports.js';

const url = new URL('../store/login-codes.js', import.meta.url).href;

test('every real export is present, so a newly added export can never break the importing test file', async () => {
  const real = await import(url);
  const mocked = await strictExports(url);
  for (const k of Object.keys(real).filter((k) => k !== 'default')) assert.ok(k in mocked, k);
});
test('database-touching (async) exports throw a named error instead of reaching the database', async () => {
  const mocked = await strictExports(url);
  await assert.rejects(mocked.issueLoginCode('a@b.c'), /issueLoginCode is not mocked in this test/);
});
test('pure exports stay real, and overrides win', async () => {
  const mocked = await strictExports(url, { CODE_MINUTES: 99 });
  assert.equal(mocked.normalizeCode('12-34 56'), '123456');
  assert.equal(mocked.CODE_MINUTES, 99);
});
