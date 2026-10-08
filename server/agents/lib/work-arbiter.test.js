import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  findContests, resolveContestDeterministically, scopeKeyForRecommendation,
  runWorkArbiter, isWorkArbiterEnabled,
} from './work-arbiter.js';

const rec = (id, type, params = {}, over = {}) => ({
  id, recommendation_type: type, params, title: `${type} ${id}`, why_it_matters: 'because', ...over,
});

const blogOn = (id, topic) => rec(id, 'blog-outline', { topic });
const expandOn = (id, page) => rec(id, 'expand-content', { page });
const linkOn = (id, page) => rec(id, 'internal-links', { page });
// 'translation' carries the new-blog intent but contends on a PAGE, which is
// the one way a new-page proposal and an expansion share a scope key.
const newPageOn = (id, page) => rec(id, 'translation', { page });

describe('scopeKeyForRecommendation', () => {
  test('a content generator contends on its topic, a page fix on its page', () => {
    assert.deepEqual(scopeKeyForRecommendation(blogOn(1, 'AI in Education')), {
      scope: 'topic', scopeKey: 'ai-in-education', intent: 'new-blog',
    });
    assert.deepEqual(scopeKeyForRecommendation(expandOn(2, 'https://x.com/guides/visas/')), {
      scope: 'page', scopeKey: '/guides/visas', intent: 'expand-existing',
    });
  });

  test('a recommendation with nothing to contend on is not arbitrable', () => {
    assert.equal(scopeKeyForRecommendation(rec(1, 'blog-outline', {})), null);
    assert.equal(scopeKeyForRecommendation(rec(2, 'meta-title', {})), null);
  });
});

describe('findContests', () => {
  test('one proposal per key is not a contest — the common case costs nothing', () => {
    assert.deepEqual(findContests([blogOn(1, 'a'), blogOn(2, 'b')]), []);
  });

  test('two different competing intents on one key is a contest', () => {
    const contests = findContests([expandOn(1, '/p'), linkOn(2, '/p')]);
    assert.equal(contests.length, 1);
    assert.equal(contests[0].scopeKey, '/p');
    assert.deepEqual(contests[0].contenders.map((c) => c.intent).sort(), ['expand-existing', 'internal-link']);
  });

  test('three proposals of the SAME intent is a dedup problem, not an arbitration one', () => {
    // The recommendations index already prevents this; arbitrating it would
    // block real work for no reason.
    assert.deepEqual(findContests([expandOn(1, '/p'), expandOn(2, '/p')]), []);
  });

  test('a metadata fix and a content addition on one page are both wanted, never rivals', () => {
    // meta-title and expand-content are not alternatives to each other.
    // Grouping them as rivals would block a fix the site genuinely needs.
    assert.deepEqual(findContests([rec(1, 'meta-title', { page: '/p' }), expandOn(2, '/p')]), []);
  });

  test('a page contest and a topic contest are kept apart', () => {
    const contests = findContests([expandOn(1, '/p'), linkOn(2, '/p'), blogOn(3, 'x'), rec(4, 'landing-page', { topic: 'x' })]);
    // The topic pair is blog-outline vs landing-page — both 'new-blog', so
    // one intent, not a contest.
    assert.equal(contests.length, 1);
    assert.equal(contests[0].scope, 'page');
  });
});

describe('resolveContestDeterministically', () => {
  const contestOf = (...recs) => findContests(recs)[0];

  test('on a COVERED topic, expanding beats writing a new page', () => {
    const contest = { scope: 'topic', scopeKey: 'x', contenders: [
      { rec: blogOn(1, 'x'), intent: 'new-blog' },
      { rec: expandOn(2, '/x'), intent: 'expand-existing' },
    ] };
    const out = resolveContestDeterministically(contest, { coverageStatus: 'covered' });

    assert.equal(out.winner.intent, 'expand-existing');
    assert.deepEqual(out.losers.map((l) => l.intent), ['new-blog']);
    assert.equal(out.decisive, true);
  });

  test('on a genuine GAP, a new page beats expanding', () => {
    const contest = { scope: 'topic', scopeKey: 'x', contenders: [
      { rec: expandOn(1, '/x'), intent: 'expand-existing' },
      { rec: blogOn(2, 'x'), intent: 'new-blog' },
    ] };
    const out = resolveContestDeterministically(contest, { coverageStatus: 'opportunity' });

    assert.equal(out.winner.intent, 'new-blog');
    assert.equal(out.decisive, true);
  });

  test('new-blog vs expand with NO coverage verdict is NOT decisive — the residue worth escalating', () => {
    // resolveIntentConflict flips on exactly one input. With no verdict it
    // takes the not-covered branch, so "write a new page" wins by default
    // whenever nobody established coverage — and duplicating an existing
    // page is the most expensive mistake available here.
    const contest = { scope: 'topic', scopeKey: 'x', contenders: [
      { rec: blogOn(1, 'x'), intent: 'new-blog' },
      { rec: expandOn(2, '/x'), intent: 'expand-existing' },
    ] };

    assert.equal(resolveContestDeterministically(contest).decisive, false);
    assert.equal(resolveContestDeterministically(contest, { coverageStatus: 'uncertain' }).decisive, false);
    assert.equal(resolveContestDeterministically(contest, { coverageStatus: 'opportunity' }).decisive, true);
    assert.equal(resolveContestDeterministically(contest, { coverageStatus: 'covered' }).decisive, true);
  });

  test('a pairing whose ordering does not depend on coverage stays decisive without a verdict', () => {
    // internal-link is ordered the same way against both of the others in
    // either ranking, so an unknown verdict makes it no less certain.
    const contest = { scope: 'page', scopeKey: '/p', contenders: [
      { rec: expandOn(1, '/p'), intent: 'expand-existing' },
      { rec: linkOn(2, '/p'), intent: 'internal-link' },
    ] };
    assert.equal(resolveContestDeterministically(contest).decisive, true);
  });

  test('a real contest found by findContests resolves end to end', () => {
    const out = resolveContestDeterministically(contestOf(expandOn(1, '/p'), linkOn(2, '/p')), { coverageStatus: 'covered' });
    assert.equal(out.winner.intent, 'internal-link');
  });
});

function fakes(over = {}) {
  const blocked = [];
  return {
    blocked,
    deps: {
      listOpen: async () => over.open ?? [],
      block: async (id, reason) => { blocked.push({ id, reason }); },
      coverageFor: async () => over.coverage ?? null,
      decideFn: over.decideFn ?? null,
      ...over.deps,
    },
  };
}

describe('runWorkArbiter', () => {
  beforeEach(() => { process.env.WORK_ARBITER_ENABLED = 'true'; });
  afterEach(() => { delete process.env.WORK_ARBITER_ENABLED; });

  test('does nothing at all when the flag is off', async () => {
    delete process.env.WORK_ARBITER_ENABLED;
    const { deps, blocked } = fakes({ open: [expandOn(1, '/p'), linkOn(2, '/p')] });
    const out = await runWorkArbiter(1, { deps });

    assert.equal(out.ran, false);
    assert.equal(out.reason, 'disabled');
    assert.deepEqual(blocked, []);
  });

  test('no contests means nothing is touched', async () => {
    const { deps, blocked } = fakes({ open: [blogOn(1, 'a'), blogOn(2, 'b')] });
    const out = await runWorkArbiter(1, { deps });

    assert.equal(out.ran, true);
    assert.equal(out.contests, 0);
    assert.deepEqual(blocked, []);
  });

  test('a topic key and a page key are different keys, so they never contend', async () => {
    const { deps, blocked } = fakes({ open: [blogOn(1, 'ai'), expandOn(2, '/ai')], coverage: 'covered' });
    const out = await runWorkArbiter(1, { deps });

    assert.equal(out.contests, 0);
    assert.deepEqual(blocked, []);
  });

  test('the loser is BLOCKED with a readable reason, never closed', async () => {
    // An expansion that lost this week is second, not wrong — once the
    // winner ships and coverage changes it may be the right call. Closing it
    // would throw that away; blocking keeps it on the board with a reason.
    const { deps, blocked } = fakes({ open: [newPageOn(1, '/ai'), expandOn(2, '/ai')], coverage: 'covered' });
    const out = await runWorkArbiter(1, { deps });

    assert.equal(out.contests, 1);
    assert.equal(out.blocked, 1);
    assert.deepEqual(blocked.map((b) => b.id), [1], 'on a covered page, expanding wins and the new page is held');
    assert.match(blocked[0].reason, /second, not wrong/);
    assert.match(blocked[0].reason, /becomes available again/);
  });

  test('a real same-key contest blocks exactly the losers', async () => {
    const { deps, blocked } = fakes({ open: [expandOn(1, '/p'), linkOn(2, '/p')], coverage: 'covered' });
    const out = await runWorkArbiter(1, { deps });

    assert.equal(out.contests, 1);
    assert.equal(out.blocked, 1);
    assert.deepEqual(blocked.map((b) => b.id), [1]);
    assert.match(blocked[0].reason, /second, not wrong/);
    assert.equal(out.results[0].winnerIntent, 'internal-link');
  });

  test('an unreadable recommendation list is reported, not treated as "no contests"', async () => {
    const { deps, blocked } = fakes({ deps: { listOpen: async () => { throw new Error('db down'); } } });
    const out = await runWorkArbiter(1, { deps });

    assert.equal(out.ran, false);
    assert.equal(out.reason, 'unavailable');
    assert.deepEqual(blocked, []);
  });

  test('a failed block does not count as blocked, and does not stop the run', async () => {
    const { deps } = fakes({
      open: [expandOn(1, '/p'), linkOn(2, '/p'), expandOn(3, '/q'), linkOn(4, '/q')],
      coverage: 'covered',
      deps: { block: async (id) => { if (id === 1) throw new Error('row vanished'); } },
    });
    const out = await runWorkArbiter(1, { deps });

    assert.equal(out.contests, 2);
    assert.equal(out.blocked, 1);
  });

  test('escalation only happens for an INDECISIVE contest, and only when the engine is enabled for the site', async () => {
    let calls = 0;
    const decideFn = async () => { calls++; return { id: 9, action: 'improve_page' }; };

    // Decisive: a real coverage verdict settled it, so no call.
    const decisive = fakes({ open: [newPageOn(1, '/p'), expandOn(2, '/p')], coverage: 'covered', deps: { decideFn } });
    await runWorkArbiter(1, { site: { decision_engine_default_bucket_enabled: true }, deps: decisive.deps });
    assert.equal(calls, 0);

    // Indecisive (no coverage verdict), but the engine is off for this site.
    const off = fakes({ open: [newPageOn(3, '/q'), expandOn(4, '/q')], deps: { decideFn } });
    await runWorkArbiter(1, { site: { decision_engine_default_bucket_enabled: false }, deps: off.deps });
    assert.equal(calls, 0);

    // Indecisive and enabled.
    const on = fakes({ open: [newPageOn(5, '/r'), expandOn(6, '/r')], deps: { decideFn } });
    const out = await runWorkArbiter(1, { site: { decision_engine_default_bucket_enabled: true }, deps: on.deps });
    assert.equal(calls, 1);
    assert.equal(out.results[0].reason, 'decided');
    assert.equal(out.results[0].winnerId, 6, 'improve_page maps to the expansion');
  });

  test('escalation respects the existing max-5 budget rather than inventing a second one', async () => {
    let calls = 0;
    const open = [];
    for (let i = 0; i < 8; i++) open.push(newPageOn(i * 2, `/p${i}`), expandOn(i * 2 + 1, `/p${i}`));
    const { deps } = fakes({ open, deps: { decideFn: async () => { calls++; return null; } } });

    const out = await runWorkArbiter(1, { site: { decision_engine_default_bucket_enabled: true }, deps });

    assert.equal(out.contests, 8);
    assert.equal(calls, 5);
    assert.equal(out.decisions, 5);
  });

  test('a decide() answer outside the intent vocabulary leaves precedence standing', async () => {
    // The engine did not answer the question it was asked. Mapping that onto
    // a contender anyway would turn an indecisive contest into an arbitrary one.
    const { deps } = fakes({
      open: [newPageOn(1, '/p'), expandOn(2, '/p')],
      deps: { decideFn: async () => ({ id: 9, action: 'do_nothing' }) },
    });
    const out = await runWorkArbiter(1, { site: { decision_engine_default_bucket_enabled: true }, deps });

    assert.notEqual(out.results[0].reason, 'decided');
    assert.equal(out.results[0].winnerId, 1, 'with no coverage verdict, precedence still prefers the new page');
  });

  test('a thrown decide() leaves precedence standing', async () => {
    const { deps } = fakes({
      open: [newPageOn(1, '/p'), expandOn(2, '/p')],
      deps: { decideFn: async () => { throw new Error('rate limited'); } },
    });
    const out = await runWorkArbiter(1, { site: { decision_engine_default_bucket_enabled: true }, deps });
    assert.equal(out.results[0].winnerId, 1);
  });
});

describe('isWorkArbiterEnabled', () => {
  test('off unless explicitly turned on', () => {
    assert.equal(isWorkArbiterEnabled({}), false);
    assert.equal(isWorkArbiterEnabled({ WORK_ARBITER_ENABLED: 'true' }), true);
  });
});
