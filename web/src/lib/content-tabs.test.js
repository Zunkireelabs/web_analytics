import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { contentTabFor, initialDraftsTab, viewFromParam, CONTENT_TABS } from './content-tabs.js';

describe('content tabs', () => {
  test('the view comes from ?view=, anything else is Ideas', () => {
    assert.equal(viewFromParam('history'), 'history');
    assert.equal(viewFromParam('review'), 'review');
    assert.equal(viewFromParam(null), 'ideas');
    assert.equal(viewFromParam('x'), 'ideas');
  });
  test('all three steps live on the Content page itself', () => {
    assert.ok(CONTENT_TABS.every((t) => t.to.startsWith('/content')) && CONTENT_TABS.every((t) => !t.to.startsWith('/content/')));
  });
  test('three steps, in order, each with its own address', () => {
    assert.deepEqual(CONTENT_TABS.map((t) => t.id), ['ideas', 'review', 'history']);
    assert.equal(new Set(CONTENT_TABS.map((t) => t.to)).size, 3);
  });
  test('the right tab lights up on each screen', () => {
    assert.equal(contentTabFor('studio'), 'ideas');
    assert.equal(contentTabFor('drafts', 'drafts'), 'review');
    assert.equal(contentTabFor('drafts', 'implemented'), 'history');
  });
  test('the older idea list inside the review screen lights none of them', () => {
    assert.equal(contentTabFor('drafts', 'recommendations'), null);
  });
  test('the review screen opens on drafts, or on the tab asked for', () => {
    assert.equal(initialDraftsTab(null, true), 'drafts');
    assert.equal(initialDraftsTab('implemented', true), 'implemented');
    assert.equal(initialDraftsTab('nonsense', true), 'drafts');
  });
  test('Action Center itself still opens on its issues', () => {
    assert.equal(initialDraftsTab(null, false), 'recommendations');
    assert.equal(initialDraftsTab('drafts', false), 'drafts');
  });
});
