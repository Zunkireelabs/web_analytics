import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordSkippedShipRun, SKIP_REASON } from './job.js';

test('a skipped project leaves a run row with the reason, the project and the lane', async () => {
  const rows = [];
  await recordSkippedShipRun({ id: 8871, auto_remediation_daily_limit: 60 }, SKIP_REASON.CREDENTIAL_LOCKED, 'Another project held the credential.', { drainOnly: true, record: async (siteId, row) => rows.push({ siteId, ...row }) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].siteId, 8871, 'attributed to exactly this project');
  assert.equal(rows[0].attempted, 0);
  assert.equal(rows[0].dailyLimit, 60);
  assert.equal(rows[0].stoppedReason, 'credential-locked');
  assert.equal(rows[0].selection.runSkipped, true);
  assert.equal(rows[0].selection.lane, 'drain-only');
  assert.match(rows[0].selection.detail, /credential/);
  assert.ok(rows[0].selection.scheduledAt);
});

test('each distinct reason is distinguishable', () => {
  assert.equal(new Set(Object.values(SKIP_REASON)).size, Object.keys(SKIP_REASON).length);
  for (const r of ['credential-locked', 'site-locked', 'window-closed', 'global-ceiling-reached', 'timed-out', 'run-error']) assert.ok(Object.values(SKIP_REASON).includes(r), r);
});

test('a failing recorder can never break the run', async () => {
  await assert.doesNotReject(recordSkippedShipRun({ id: 1 }, SKIP_REASON.RUN_ERROR, 'x', { record: async () => { throw new Error('db down'); } }));
});

test('a long detail is bounded', async () => {
  const rows = [];
  await recordSkippedShipRun({ id: 1 }, SKIP_REASON.RUN_ERROR, 'x'.repeat(5000), { record: async (_id, row) => rows.push(row) });
  assert.ok(rows[0].selection.detail.length <= 300);
});

test('a raw error in a run-error skip is sanitised before it is stored', async () => {
  const rows = [];
  await recordSkippedShipRun({ id: 1 }, SKIP_REASON.RUN_ERROR, 'Request failed with status code 500: Internal Server Error', { record: async (_id, row) => rows.push(row) });
  assert.doesNotMatch(rows[0].selection.detail, /status code 500/);
});
