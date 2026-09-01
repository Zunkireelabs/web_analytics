import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyPacing, applyConvergenceCap, MAX_FAILED_ATTEMPTS } from './ship-pacing.js';

// Both collaborators are injectable, so this suite needs neither a database
// nor module mocks — the rules under test are pure candidate filtering.
const site = { id: 1, timezone: 'Asia/Kolkata' };
const never = async () => false;

function rec(id, { type = 'meta-title', findingIds = [`f${id}`] } = {}) {
  return { id, recommendation_type: type, finding_ids: findingIds };
}

// These two rules lived only on the unattended cron path. The manual bulk
// path (routes/action-center.js's executeSafeFixes) had neither, and it is
// the path that carries the volume: on 2026-09-01 three bulk runs drafted 61
// blog-outlines and opened one PR with 42 net-new blog posts. This module
// exists so both paths apply the identical rule.
describe('applyPacing', () => {
  test('thins a paced generator to one per run, keeping the highest-priority candidate', async () => {
    const candidates = [rec(1, { type: 'blog-outline' }), rec(2, { type: 'blog-outline' }), rec(3, { type: 'blog-outline' })];
    const { paced, notes } = await applyPacing(site, candidates, { recentDraftCheck: never });

    assert.deepEqual(paced.map((r) => r.id), [1], 'candidates arrive in priority order — the first survives');
    assert.match(notes[0], /taking 1 of 3/);
  });

  test('holds a paced generator entirely when one was published inside the gap window', async () => {
    const candidates = [rec(1, { type: 'blog-outline' }), rec(2, { type: 'blog-outline' })];
    const { paced, notes } = await applyPacing(site, candidates, { recentDraftCheck: async () => true });

    assert.deepEqual(paced, []);
    assert.match(notes[0], /held/);
  });

  test('never touches an unpaced generator — pacing is about publishing cadence, not throughput', async () => {
    const candidates = [rec(1, { type: 'meta-title' }), rec(2, { type: 'faq' }), rec(3, { type: 'meta-title' })];
    const { paced, notes } = await applyPacing(site, candidates, { recentDraftCheck: async () => true });

    assert.deepEqual(paced.map((r) => r.id), [1, 2, 3]);
    assert.deepEqual(notes, []);
  });

  test('a held blog does not take an ordinary fix down with it', async () => {
    const candidates = [rec(1, { type: 'blog-outline' }), rec(2, { type: 'meta-title' })];
    const { paced } = await applyPacing(site, candidates, { recentDraftCheck: async (siteId, type) => type === 'blog-outline' });

    assert.deepEqual(paced.map((r) => r.id), [2]);
  });
});

// The churn this ends, measured on site 1 over three days: 623 drafts for 496
// distinct findings, single findings redrafted up to TEN times, every attempt
// abandoned. Abandoning un-hides a finding so it can be retried — right for a
// transient failure, wrong for a permanent one, and nothing told them apart.
describe('applyConvergenceCap', () => {
  test('drops a finding that has already failed the maximum number of times', async () => {
    const attemptCounts = new Map([['f2', MAX_FAILED_ATTEMPTS]]);
    const { converged, notes } = await applyConvergenceCap(site, [rec(1), rec(2), rec(3)], { attemptCounts });

    assert.deepEqual(converged.map((r) => r.id), [1, 3]);
    assert.match(notes[0], /held after 3 failed attempt/);
  });

  test('keeps a finding still under the cap — an early failure can genuinely be bad luck', async () => {
    const attemptCounts = new Map([['f1', MAX_FAILED_ATTEMPTS - 1]]);
    const { converged, notes } = await applyConvergenceCap(site, [rec(1)], { attemptCounts });

    assert.deepEqual(converged.map((r) => r.id), [1]);
    assert.deepEqual(notes, []);
  });

  // A recommendation can carry several findings; one permanently-unfixable
  // component is enough to make the whole thing fail identically every run.
  test('uses the highest attempt count among a recommendation\'s findings', async () => {
    const attemptCounts = new Map([['fa', 0], ['fb', MAX_FAILED_ATTEMPTS + 4]]);
    const { converged } = await applyConvergenceCap(site, [rec(1, { findingIds: ['fa', 'fb'] })], { attemptCounts });

    assert.deepEqual(converged, []);
  });

  test('a finding with no failure history is untouched', async () => {
    const { converged, notes } = await applyConvergenceCap(site, [rec(1), rec(2)], { attemptCounts: new Map() });

    assert.deepEqual(converged.map((r) => r.id), [1, 2]);
    assert.deepEqual(notes, []);
  });

  test('an empty candidate list short-circuits without consulting the store', async () => {
    let consulted = false;
    const { converged } = await applyConvergenceCap(site, [], {
      attemptCounts: new Proxy(new Map(), { get: () => { consulted = true; return undefined; } }),
    });

    assert.deepEqual(converged, []);
    assert.equal(consulted, false);
  });
});
