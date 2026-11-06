import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWriteAllowed, requireWriteAllowed, isLocalDatabase } from './script-guard.js';

const env = (url) => ({ DATABASE_URL: url });
const REMOTE = 'postgres://u:p@aws-0-example.pooler.example.com:5432/postgres';

test('a local database is always writable', () => {
  assert.equal(checkWriteAllowed({}, env('postgres://postgres:dev@localhost:55432/analytics')).ok, true);
  assert.equal(checkWriteAllowed({}, env('postgres://x@127.0.0.1/db')).local, true);
  assert.equal(isLocalDatabase(env('postgres://x@[::1]/db')), true);
});

test('a remote database refuses writes by default, naming the host', () => {
  const r = checkWriteAllowed({}, env(REMOTE));
  assert.equal(r.ok, false);
  assert.match(r.reason, /pooler\.example\.com/);
  assert.throws(() => requireWriteAllowed({}, env(REMOTE)), /Write refused/);
});

test('--allow-remote alone is not enough: a named person is required', () => {
  assert.equal(checkWriteAllowed({ 'allow-remote': true }, env(REMOTE)).ok, false);
  assert.equal(checkWriteAllowed({ 'allow-remote': true, by: '  ' }, env(REMOTE)).ok, false);
  assert.equal(checkWriteAllowed({ 'allow-remote': true, by: 'Yukta' }, env(REMOTE)).ok, true);
});

test('a look-alike host does not pass as local', () => {
  assert.equal(checkWriteAllowed({}, env('postgres://x@localhost.evil.example/db')).ok, false);
  assert.equal(checkWriteAllowed({}, env('postgres://x@notlocalhost/db')).ok, false);
});

test('a missing or broken DATABASE_URL refuses', () => {
  assert.equal(checkWriteAllowed({}, {}).ok, false);
  assert.equal(checkWriteAllowed({}, env('not a url')).ok, false);
});
