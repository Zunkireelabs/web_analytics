import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { draftTitle, reviewLists, historyByMonth, filterHistory, contentTypeLabel, waitedDays } from './content-history.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const d = (o) => ({ id: 1, action_type: 'blog-outline', status: 'draft', content: {}, input: { page: '/blog/x/' }, created_at: '2026-11-18T09:00:00Z', ...o });

describe('titles', () => {
  test('a draft uses its own headline, then falls back to type and page', () => {
    assert.equal(draftTitle(d({ content: { title: 'How salon software cuts no-shows' } })), 'How salon software cuts no-shows');
    assert.equal(draftTitle(d({ action_type: 'landing-page', content: { headline: 'Never lose a walk-in' } })), 'Never lose a walk-in');
    assert.equal(draftTitle(d({ action_type: 'translation', content: { translatedTitle: 'सैलुन' } })), 'सैलुन');
    assert.equal(draftTitle(d({})), 'Blog post: /blog/x/');
  });
  test('type labels are plain words', () => {
    assert.equal(contentTypeLabel('landing-page'), 'Landing page');
    assert.equal(contentTypeLabel('something-new'), 'Something new');
  });
});

describe('to review', () => {
  test('waiting on the client comes first, oldest first; on its way is separate', () => {
    const r = reviewLists([d({ id: 1, created_at: '2026-11-19T09:00:00Z' }), d({ id: 2, status: 'submitted_for_approval', created_at: '2026-11-15T09:00:00Z' }),
      d({ id: 3, status: 'pr_opened', approved_at: '2026-11-17T09:00:00Z', pr_number: 245 }), d({ id: 4, status: 'implemented', implemented_at: '2026-11-10T09:00:00Z' })], NOW);
    assert.deepEqual(r.waiting.map((x) => x.id), [2, 1]);
    assert.deepEqual(r.onItsWay.map((x) => x.id), [3]);
    assert.equal(r.onItsWay[0].pr.number, 245);
  });
  test('waited days counts whole days', () => assert.equal(waitedDays(d({ created_at: '2026-11-18T09:00:00Z' }), NOW), 2));
});

describe('live history', () => {
  const live = (id, at, type = 'blog-outline', extra = {}) => d({ id, status: 'implemented', implemented_at: at, action_type: type, pr_number: 200 + id, branch_name: `agent/b${id}`, ...extra });
  test('newest first and grouped by month, with the PR and branch of each', () => {
    const h = historyByMonth([live(1, '2026-10-22T10:00:00Z'), live(2, '2026-11-13T10:00:00Z'), live(3, '2026-11-07T10:00:00Z'), d({ id: 9, status: 'draft' })], NOW);
    assert.equal(h.total, 3);
    assert.deepEqual(h.groups.map((g) => g.label), ['November 2026', 'October 2026']);
    assert.deepEqual(h.groups[0].items.map((i) => i.id), [2, 3]);
    assert.equal(h.groups[0].items[0].pr.number, 202);
    assert.equal(h.groups[0].items[0].branch, 'agent/b2');
  });
  test('a draft that never went live is not in the history', () => {
    assert.equal(historyByMonth([d({ status: 'draft' }), d({ status: 'implemented', implemented_at: null })], NOW).total, 0);
  });
  test('filtering by type drops empty months', () => {
    const h = historyByMonth([live(1, '2026-10-22T10:00:00Z', 'translation'), live(2, '2026-11-13T10:00:00Z', 'landing-page')], NOW);
    assert.deepEqual(filterHistory(h.groups, 'translation').map((g) => g.label), ['October 2026']);
    assert.equal(filterHistory(h.groups, 'all').length, 2);
  });
});
