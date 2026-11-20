import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summary, engineRows, groupWords, shipIds, trend, MAX_SHIP } from './ai-visibility-view.js';

describe('headline', () => {
  test('N of M, with a percentage', () => assert.deepEqual(summary([{}, {}], [{}, {}, {}]), { n: 2, total: 5, pct: 40 }));
  test('nothing checked yet is zero, not a divide by zero', () => assert.deepEqual(summary([], []), { n: 0, total: 0, pct: 0 }));
});

describe('by engine', () => {
  const seen = [{ engines: ['openai', 'perplexity'], seenOn: ['openai'] }, { engines: ['openai'], seenOn: ['openai'] }];
  const missing = [{ engines: ['openai', 'perplexity'], seenOn: [] }];
  test('each engine counts the questions it named you in, out of those it was asked', () => {
    const r = engineRows([{ id: 'openai', configured: true }, { id: 'perplexity', configured: true }], seen, missing);
    assert.deepEqual(r.map((x) => [x.id, x.n, x.total, x.pct]), [['openai', 2, 3, 67], ['perplexity', 0, 2, 0]]);
  });
  test('an engine nobody asked has zero, and keeps its connected flag', () => {
    const r = engineRows([{ id: 'claude', configured: false }], seen, missing);
    assert.deepEqual(r[0], { id: 'claude', configured: false, n: 0, total: 0, pct: 0 });
  });
});

describe('words to add, by page', () => {
  const words = [{ phrase: 'a', page: '/x', promptIds: [1] }, { phrase: 'b', page: '/x', promptIds: [1, 2] }, { phrase: 'c', page: null, promptIds: [3] }, { phrase: 'd', page: '/y', promptIds: [4] }, { phrase: 'e', page: '/x', promptIds: [5] }];
  test('grouped by page, the page with most phrases first, unique question ids per page', () => {
    const g = groupWords(words);
    assert.equal(g[0].page, '/x');
    assert.equal(g[0].count, 3);
    assert.deepEqual(g[0].promptIds.sort(), [1, 2, 5]);
  });
  test('a phrase with no page goes under "new page" (page null)', () => assert.ok(groupWords(words).some((x) => x.page === null && x.phrases[0] === 'c')));
});

describe('what a Draft press sends', () => {
  test('unique ids, capped at what the server accepts, with the rest counted', () => {
    const many = Array.from({ length: 40 }, (_, i) => i + 1).concat([1, 2]);
    const r = shipIds(many);
    assert.equal(r.ids.length, MAX_SHIP);
    assert.equal(r.left, 15);
  });
});

describe('trend', () => {
  test('up, down, same, and nothing when there is no earlier point', () => {
    assert.deepEqual(trend([{ pct: 30 }, { pct: 40 }]), { dir: 'up', points: 10 });
    assert.deepEqual(trend([{ pct: 40 }, { pct: 35 }]), { dir: 'down', points: 5 });
    assert.deepEqual(trend([{ pct: 40 }, { pct: 40 }]), { dir: 'same', points: 0 });
    assert.equal(trend([{ pct: 40 }]), null);
  });
});
