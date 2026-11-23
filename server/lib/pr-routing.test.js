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

  test('tag-only edits (nothing visible) go straight to main even when the client has a stage branch', () => {
    const r = routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: ['meta-title', 'canonical', 'meta-title'] });
    assert.deepEqual(r, { base: 'main', goesToStage: false, reason: 'light-content-only' });
  });

  test('a landing page, a blog post, or a template fix sends the WHOLE day to stage', () => {
    for (const heavy of ['landing-page', 'blog-post', 'translation', 'schema-repair', 'schema', 'redirect-add', 'sitemap']) {
      const r = routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: ['meta-title', heavy] });
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

  test('every edit that cannot change how a page looks goes straight to main, alone or together', () => {
    const invisible = ['meta-title', 'alt-text', 'open-graph', 'canonical'];
    for (const t of invisible) assert.equal(routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: [t] }).base, 'main', t);
    assert.equal(routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: invisible }).goesToStage, false);
  });

  // MOBILISE and Superrank, 2026-11-23: FAQs shipped as unstyled text. They had been classed as light, so they went straight to main with no stage look.
  test('anything that adds or rewrites VISIBLE content goes to stage first, even alone', () => {
    for (const visible of ['faq', 'direct-answer', 'internal-links', 'expand-content', 'qa-content', 'refresh-content']) {
      const r = routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: [visible] });
      assert.equal(r.base, 'stage', visible);
      assert.equal(r.goesToStage, true, visible);
    }
  });

  test('one visible fix among invisible ones sends the whole day to stage', () => {
    assert.equal(routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: ['meta-title', 'canonical', 'faq'] }).base, 'stage');
  });

  test('one landing page or translation among them still sends the whole day to stage', () => {
    for (const heavy of ['landing-page', 'translation']) {
      assert.equal(routeBatch({ defaultBranch: 'main', stageBranch: 'stage', actionTypes: ['meta-title', 'canonical', heavy] }).base, 'stage', heavy);
    }
  });

  test('the light list is exactly the tag and alt-text edits: nothing a visitor can see', () => {
    assert.deepEqual([...LIGHT_CONTENT_TYPES].sort(), ['alt-text', 'canonical', 'meta-title', 'open-graph']);
  });
});
