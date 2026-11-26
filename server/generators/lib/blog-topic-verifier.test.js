import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBlogTopic } from './blog-topic-verifier.js';

const rec = (params = { topic: 'Financial aid for students' }, extra = {}) => ({ site_id: 8862, params, ...extra });
const classify = (v) => async () => v;

describe('verifyBlogTopic', () => {
  test('a topic the site already covers is resolved, with the page that covers it', async () => {
    const v = await verifyBlogTopic(rec(), {}, classify({ status: 'covered', url: 'https://x.test/aid/' }));
    assert.equal(v.decision, 'already_resolved');
    assert.equal(v.evidence.coveredBy, 'https://x.test/aid/');
  });
  test('a near-duplicate is treated the same way', async () => {
    assert.equal((await verifyBlogTopic(rec(), {}, classify({ status: 'duplicate', url: 'https://x.test/a/' }))).decision, 'already_resolved');
  });
  test('"covered" with no page to point at proves nothing, so the draft goes ahead', async () => {
    assert.equal((await verifyBlogTopic(rec(), {}, classify({ status: 'covered', url: null }))).decision, 'still_valid');
  });
  test('an uncovered topic is still valid', async () => {
    assert.equal((await verifyBlogTopic(rec(), {}, classify({ status: 'gap', url: null }))).decision, 'still_valid');
  });
  test('a topic a person asked for by name is never closed on coverage', async () => {
    let called = false;
    const v = await verifyBlogTopic(rec({ topic: 't', clientRequested: true }), {}, async () => { called = true; return { status: 'covered', url: 'u' }; });
    assert.equal(v.decision, 'still_valid'); assert.equal(called, false);
  });
  test('no topic or no site: not checkable', async () => {
    assert.equal((await verifyBlogTopic({ params: {} }, {}, classify({}))).reason, 'not-checkable');
    assert.equal((await verifyBlogTopic({ params: { topic: 't' } }, {}, classify({}))).reason, 'not-checkable');
  });
  test('uses the site from the context when the row has none, and never asks the model', async () => {
    let seen;
    await verifyBlogTopic({ params: { topic: 't' } }, { site: { id: 5 } }, async (id, gap, opts) => { seen = [id, opts]; return { status: 'gap' }; });
    assert.deepEqual(seen, [5, { allowLLM: false, persist: false }]);
  });

  // The content index sees what page coverage cannot: the same topic already being made.
  const inflight = (state, extra = {}) => async () => ({ entries: [{ kind: 'blog', state, url: null, title: 'Student accommodation in London', tokens: ['student', 'accommodation', 'london'], draftId: 5, ...extra }] });
  test('a topic already in a draft, an approved draft, an open pull request or merged content is resolved by the content index', async () => {
    for (const state of ['draft', 'approved', 'in_pr', 'merged']) {
      const v = await verifyBlogTopic(rec({ topic: 'student accommodation in london' }), {}, classify({ status: 'gap', url: null }), inflight(state));
      assert.equal(v.decision, 'already_resolved', state); assert.equal(v.reason, 'topic-already-in-content-index');
      assert.match(v.evidence.indexReason, /already/);
    }
  });
  test('a different topic passes the index; an unreadable index never blocks', async () => {
    assert.equal((await verifyBlogTopic(rec({ topic: 'ielts preparation guide' }), {}, classify({ status: 'gap', url: null }), inflight('in_pr'))).decision, 'still_valid');
    assert.equal((await verifyBlogTopic(rec({ topic: 'student accommodation in london' }), {}, classify({ status: 'gap', url: null }), async () => { throw new Error('db down'); })).decision, 'still_valid');
  });
  test('a person-requested topic still skips both checks', async () => {
    const v = await verifyBlogTopic(rec({ topic: 'student accommodation in london', clientRequested: true }), {}, classify({ status: 'gap' }), inflight('in_pr'));
    assert.equal(v.decision, 'still_valid');
  });
});
