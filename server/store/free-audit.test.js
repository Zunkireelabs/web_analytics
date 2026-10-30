import test from 'node:test';
import assert from 'node:assert/strict';
import { getReport, ID_RE } from './free-audit.js';

// A report id is a 32-hex capability; anything else must be rejected before it reaches the database.
test('report ids that are not 32 hex chars never reach the database', async () => {
  assert.equal(ID_RE.test('a'.repeat(32)), true);
  assert.equal(await getReport('../../etc/passwd'), null);
  assert.equal(await getReport('abc'), null);
  assert.equal(await getReport(undefined), null);
});
