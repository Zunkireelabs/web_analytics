import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_GENERATOR_IDS, inDraftScope } from './draft-scope.js';

describe('draft scope — Content vs Action Center', () => {
  test('content scope is only the writing generators', () => {
    for (const id of CONTENT_GENERATOR_IDS) assert.equal(inDraftScope(id, 'content'), true, id);
    for (const id of ['meta-title', 'faq', 'schema', 'robots-fix', 'llms-txt', 'security-headers', 'direct-answer']) assert.equal(inDraftScope(id, 'content'), false, id);
  });

  test('fixes scope is everything that is not content — the two scopes never overlap and never drop a draft', () => {
    for (const id of [...CONTENT_GENERATOR_IDS, 'meta-title', 'faq', 'schema', 'privacy-policy', 'alt-text', 'something-new']) {
      assert.notEqual(inDraftScope(id, 'content'), inDraftScope(id, 'fixes'), `${id} lands in exactly one`);
    }
  });

  test('no scope (or an unknown one) means every draft, as before', () => {
    for (const scope of [undefined, null, 'all', 'nonsense']) {
      assert.equal(inDraftScope('blog-outline', scope), true);
      assert.equal(inDraftScope('meta-title', scope), true);
    }
  });

  test('a new, unlisted generator is treated as a fix, so it is never hidden from the Action Center', () => {
    assert.equal(inDraftScope('brand-new-generator', 'fixes'), true);
    assert.equal(inDraftScope('brand-new-generator', 'content'), false);
  });
});
