import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catchupAction, MAX_FULL_CATCHUPS_PER_DAY } from './job.js';

// 2026-11-15..20: every report narrative was missing (the LLM had no credit), so the hourly guard re-ran the whole
// daily job for every site 10-15 times a day. These pin the replacement rule.

test('a fully done day is left alone', () => {
  assert.equal(catchupAction({ hasNarrative: true, analysisDoneToday: true }), 'skip');
});

test('agents done but narrative missing retries ONLY the narrative, however many times', () => {
  assert.equal(catchupAction({ hasNarrative: false, analysisDoneToday: true }), 'narrative-only');
  assert.equal(catchupAction({ hasNarrative: false, analysisDoneToday: true, fullAttemptsToday: 99 }), 'narrative-only');
});

test('agents not run today gets a full catch-up, but only a bounded number of times', () => {
  assert.equal(MAX_FULL_CATCHUPS_PER_DAY, 2);
  assert.equal(catchupAction({ hasNarrative: true, analysisDoneToday: false, fullAttemptsToday: 0 }), 'full');
  assert.equal(catchupAction({ hasNarrative: false, analysisDoneToday: false, fullAttemptsToday: 1 }), 'full');
  assert.equal(catchupAction({ hasNarrative: false, analysisDoneToday: false, fullAttemptsToday: 2 }), 'gave-up');
});
