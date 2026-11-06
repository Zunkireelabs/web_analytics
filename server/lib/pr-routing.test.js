import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { routeBatch, LIGHT_CONTENT_TYPES } from './pr-routing.js';

describe('routeBatch', () => {
  test('a client with no stage branch always goes straight to main', () => {
    for (const types of [['refresh-content'], ['landing-page'], ['schema-repair', 'blog-post'], []]) {
      assert.deepEqual(routeBatch({ defaultBranch: 'main', stageBranch: null, actionTypes: types }), { base: 'main', goesToStage: false, reason: 'no-stage-branch' });
    }
    assert.equal(routeBatch({ defaultBranch: 'main', stageBranch: '  ', actionTypes: ['landing-page'] }).base, 'main');
  });

  test('a stage that is the same branch as production is no stage at all', () => {
    assert.equal(routeBatch({ defaultBranch: 'main', stageBranch: 'main', actionTypes: ['landing-page'] }).goesToStage, false);
  });

  test('light content edits only go straight to main even when the client has a stage branch', () => {
    const r = routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: ['refresh-content', 'expand-content', 'refresh-content'] });
    assert.deepEqual(r, { base: 'main', goesToStage: false, reason: 'light-content-only' });
  });

  test('a landing page, a blog post, or a template fix sends the WHOLE day to stage', () => {
    for (const heavy of ['landing-page', 'blog-post', 'translation', 'schema-repair', 'schema', 'redirect-add', 'sitemap']) {
      const r = routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: ['refresh-content', heavy] });
      assert.equal(r.base, 'stage', heavy);
      assert.equal(r.goesToStage, true);
      assert.match(r.reason, new RegExp(heavy));
    }
  });

  test('an unknown batch takes the careful route', () => {
    assert.equal(routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: [] }).base, 'stage');
  });

  test('a type nobody has classified is not light', () => {
    assert.equal(routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: ['some-future-fix'] }).base, 'stage');
  });

  test('every content and tag edit the owner named goes straight to main, alone or together', () => {
    const named = ['meta-title', 'faq', 'direct-answer', 'internal-links', 'alt-text', 'open-graph', 'canonical'];
    for (const t of named) assert.equal(routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: [t] }).base, 'main', t);
    assert.equal(routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: [...named, 'refresh-content'] }).goesToStage, false);
  });

  test('one landing page or translation among them still sends the whole day to stage', () => {
    for (const heavy of ['landing-page', 'translation']) {
      assert.equal(routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: ['meta-title', 'faq', 'canonical', heavy] }).base, 'stage', heavy);
    }
  });

  test('the light list is exactly the page content and tag edits', () => {
    assert.deepEqual([...LIGHT_CONTENT_TYPES].sort(), ['alt-text', 'canonical', 'direct-answer', 'expand-content', 'faq', 'internal-links', 'meta-title', 'open-graph', 'qa-content', 'refresh-content']);
  });
});
