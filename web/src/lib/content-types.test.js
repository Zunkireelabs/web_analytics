import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_TYPES, typeFromParam, draftsOfType, stageCounts } from './content-types.js';

const d = (o) => ({ id: 1, action_type: 'blog-outline', status: 'draft', content: {}, input: {}, created_at: '2026-11-18T09:00:00Z', ...o });
const DRAFTS = [d({ id: 1 }), d({ id: 2, action_type: 'landing-page', status: 'submitted_for_approval' }), d({ id: 3, action_type: 'translation', status: 'pr_opened', pr_number: 9 }),
  d({ id: 4, status: 'implemented', implemented_at: '2026-11-10T09:00:00Z' }), d({ id: 5, action_type: 'expand-content' })];

describe('the type toggle', () => {
  test('All plus the three kinds, in order', () => assert.deepEqual(CONTENT_TYPES.map((t) => t.key), ['all', 'landing', 'translation', 'blog']));
  test('anything unknown is All', () => { assert.equal(typeFromParam('blog'), 'blog'); assert.equal(typeFromParam('x'), 'all'); assert.equal(typeFromParam(null), 'all'); });
  test('a kind keeps only its own drafts; All keeps every one, including kinds without a button', () => {
    assert.deepEqual(draftsOfType(DRAFTS, 'blog').map((x) => x.id), [1, 4]);
    assert.deepEqual(draftsOfType(DRAFTS, 'landing').map((x) => x.id), [2]);
    assert.equal(draftsOfType(DRAFTS, 'all').length, 5);
  });
});

describe('the numbers on the stage strip', () => {
  test('All counts everything: drafted = waiting + on its way, history = went live', () => {
    const c = stageCounts(DRAFTS, 'all', 3);
    assert.deepEqual(c, { ideas: 3, drafted: 4, waiting: 3, history: 1 });
  });
  test('a kind counts only its own', () => {
    assert.deepEqual(stageCounts(DRAFTS, 'blog', 1), { ideas: 1, drafted: 1, waiting: 1, history: 1 });
    assert.deepEqual(stageCounts(DRAFTS, 'translation', 0), { ideas: 0, drafted: 1, waiting: 0, history: 0 });
  });
});
