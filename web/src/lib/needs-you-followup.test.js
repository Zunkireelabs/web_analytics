import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRaiseAgain, pickItemsToRaise, rememberRaised, loadMemory } from './needs-you-followup.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const day = (n) => new Date(NOW - n * 86_400_000).toISOString();
const item = { key: 'a', blocksShipping: false };

describe('growing follow-up interval', () => {
  test('never raised before: yes', () => assert.equal(shouldRaiseAgain(item, undefined, NOW), true));
  test('raised once: wait a day', () => {
    assert.equal(shouldRaiseAgain(item, { timesRaised: 1, lastRaisedAt: day(0.5) }, NOW), false);
    assert.equal(shouldRaiseAgain(item, { timesRaised: 1, lastRaisedAt: day(1) }, NOW), true);
  });
  test('raised twice: 3 days; three or more: 7 days', () => {
    assert.equal(shouldRaiseAgain(item, { timesRaised: 2, lastRaisedAt: day(2) }, NOW), false);
    assert.equal(shouldRaiseAgain(item, { timesRaised: 2, lastRaisedAt: day(3) }, NOW), true);
    assert.equal(shouldRaiseAgain(item, { timesRaised: 5, lastRaisedAt: day(6) }, NOW), false);
    assert.equal(shouldRaiseAgain(item, { timesRaised: 5, lastRaisedAt: day(7) }, NOW), true);
  });
  test('a shipping blocker is raised every visit', () => {
    assert.equal(shouldRaiseAgain({ key: 'b', blocksShipping: true }, { timesRaised: 9, lastRaisedAt: day(0) }, NOW), true);
  });
});

describe('remembering what was raised', () => {
  test('raising counts up, and a resolved item is forgotten', () => {
    const items = [{ key: 'a' }, { key: 'b' }];
    const m1 = rememberRaised(items, items, {}, NOW);
    assert.equal(m1.a.timesRaised, 1);
    const m2 = rememberRaised([{ key: 'a' }], [{ key: 'a' }], m1, NOW);
    assert.equal(m2.a.timesRaised, 2);
    assert.equal(m2.b, undefined);
  });
  test('only items due are picked', () => {
    const memory = { a: { timesRaised: 1, lastRaisedAt: day(0.2) } };
    assert.deepEqual(pickItemsToRaise([{ key: 'a' }, { key: 'c' }], memory, NOW).map((i) => i.key), ['c']);
  });
  test('unreadable storage means an empty memory, not a crash', () => {
    assert.deepEqual(loadMemory(1, { getItem: () => { throw new Error('blocked'); } }), {});
    assert.deepEqual(loadMemory(1, { getItem: () => 'not json' }), {});
  });
});
