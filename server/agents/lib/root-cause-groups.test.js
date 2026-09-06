import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupKeyFor, groupSizes, orderByRootCause, MAX_PER_GROUP_PER_RUN } from './root-cause-groups.js';

function rec(id, { type = 'broken-link-fix', page = '/p' } = {}) {
  return { id, recommendation_type: type, params: { page }, page };
}
function scored(rec, score) {
  return { rec, score, tier: 1, tierLabel: 'critical-technical', factors: [] };
}

describe('groupKeyFor', () => {
  test('groups by (generator, page) — the level a co-located fix genuinely shares a cause and a file', () => {
    assert.equal(groupKeyFor(rec(1, { type: 'broken-link-fix', page: '/a' })), groupKeyFor(rec(2, { type: 'broken-link-fix', page: '/a' })));
  });

  test('different generators on the same page are different groups — no shared cause to bundle', () => {
    assert.notEqual(groupKeyFor(rec(1, { type: 'broken-link-fix', page: '/a' })), groupKeyFor(rec(2, { type: 'meta-title', page: '/a' })));
  });

  test('a recommendation with no page (e.g. blog-outline, keyed by topic) is its own solo group, never bundled with siblings', () => {
    const a = groupKeyFor({ id: 1, recommendation_type: 'blog-outline', params: {} });
    const b = groupKeyFor({ id: 2, recommendation_type: 'blog-outline', params: {} });
    assert.notEqual(a, b, 'two different blog topics must not collapse into one breadth-bonused group');
  });
});

describe('groupSizes', () => {
  test('counts members per group key', () => {
    const candidates = [rec(1, { page: '/a' }), rec(2, { page: '/a' }), rec(3, { page: '/b' })];
    const sizes = groupSizes(candidates);
    assert.equal(sizes.get(groupKeyFor(rec(1, { page: '/a' }))), 2);
    assert.equal(sizes.get(groupKeyFor(rec(3, { page: '/b' }))), 1);
  });
});

describe('orderByRootCause', () => {
  test('members of one group run consecutively', () => {
    const items = [
      scored(rec(1, { page: '/a' }), 100),
      scored(rec(2, { page: '/b' }), 90),
      scored(rec(3, { page: '/a' }), 80),
    ];
    const { ordered } = orderByRootCause(items);
    const ids = ordered.map((i) => i.rec.id);
    // Both /a members (1 and 3) must be adjacent, not split by /b's item.
    const posA1 = ids.indexOf(1);
    const posA3 = ids.indexOf(3);
    assert.equal(Math.abs(posA1 - posA3), 1, `/a's members must be consecutive, got order ${ids}`);
  });

  test('groups are ordered by their best member\'s score, highest first', () => {
    const items = [
      scored(rec(1, { page: '/low' }), 10),
      scored(rec(2, { page: '/high' }), 500),
    ];
    const { ordered } = orderByRootCause(items);
    assert.equal(ordered[0].rec.id, 2, 'the higher-scoring group leads');
  });

  test('a group exceeding MAX_PER_GROUP_PER_RUN is capped, and the rest are returned as deferred with a note', () => {
    const items = Array.from({ length: MAX_PER_GROUP_PER_RUN + 5 }, (_, i) => scored(rec(i + 1, { page: '/a' }), 100 - i));
    const { ordered, deferred, notes } = orderByRootCause(items);
    assert.equal(ordered.length, MAX_PER_GROUP_PER_RUN);
    assert.equal(deferred.length, 5);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /taking 8 of 13/);
  });

  test('within a capped group, the highest-scoring members are the ones taken, not the first encountered', () => {
    const items = [
      scored(rec(1, { page: '/a' }), 10),
      scored(rec(2, { page: '/a' }), 999), // lowest input-order position, highest score
    ];
    const { ordered } = orderByRootCause(items);
    assert.equal(ordered[0].rec.id, 2, 'the group\'s members are sorted best-first internally');
  });
});
