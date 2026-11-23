import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runOutcome } from './run-outcome.js';

const log = (message) => ({ at: '2026-11-23T05:50:01Z', message });

describe('runOutcome', () => {
  test('a run that shipped work reports it as before', () => {
    const r = runOutcome({ shipped: 5, failed: 1, job: { pr_url: 'https://github.com/o/r/pull/1' } });
    assert.equal(r.ok, true);
    assert.equal(r.text, 'Shipped 5, 1 failed — committed to one branch, one PR opened.');
  });

  test('a run stopped by the GitHub budget never says "Shipped 0 … one PR opened"', () => {
    // The real 2026-11-23 run: stopped before item 1, an unrelated PR was attached.
    const r = runOutcome({
      shipped: 0, failed: 0,
      job: {
        status: 'failed',
        pr_url: 'https://github.com/o/r/pull/150',
        logs: [
          log('Selected 47 safe recommendation(s) for execution (13 held by pacing/convergence rules).'),
          log('GitHub API budget under the 100-request reserve — stopping before starting more work. 47 item(s) left untouched; they will be re-attempted next run.'),
        ],
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.text, /^Nothing shipped/);
    assert.match(r.text, /47 fixes were left untouched/);
    assert.doesNotMatch(r.text, /PR opened/);
  });

  test('a failed push says the push failed', () => {
    const r = runOutcome({ shipped: 0, failed: 3, job: { logs: [log('Batch push/PR failed for b: boom — 3 item(s) reverted to failed.')] } });
    assert.equal(r.ok, false);
    assert.match(r.text, /push to GitHub failed/);
  });

  test('all items failed', () => {
    assert.equal(runOutcome({ shipped: 0, failed: 2, job: { logs: [] } }).text, 'Nothing shipped — 2 failed. Open the list to see why.');
  });

  test('nothing eligible', () => {
    const r = runOutcome({ shipped: 0, failed: 0, job: { status: 'completed', logs: [] } });
    assert.equal(r.ok, false);
    assert.match(r.text, /nothing ready to ship/);
  });
});
