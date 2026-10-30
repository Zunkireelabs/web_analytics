import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { draftForPredictedKeyword } from './analyst-keyword-draft.js';

const predicted = [{ keyword: 'seo report template', position: 11.2, gainClicks: 90 }];
const deps = (over = {}) => ({ predicted, findDraftByTopic: async () => null, generate: async () => ({ id: 42 }), ...over });

describe('draftForPredictedKeyword', () => {
  test('drafts a blog-outline grounded in the predicted keyword', async () => {
    let args;
    const r = await draftForPredictedKeyword(1, '  SEO report   template ', deps({ generate: async (siteId, a) => { args = a; return { id: 42 }; } }));
    assert.deepEqual(r, { draftId: 42, reused: false });
    assert.equal(args.generatorId, 'blog-outline'); assert.equal(args.params.topic, 'seo report template');
    assert.match(args.params.context, /position 11\.2/); assert.equal(args.findingId, 'analyst-outlook:keyword:seo report template');
  });
  test('reuses a draft that already covers the topic', async () => {
    let generated = false;
    const r = await draftForPredictedKeyword(1, 'seo report template', deps({ findDraftByTopic: async () => 7, generate: async () => { generated = true; return { id: 1 }; } }));
    assert.deepEqual(r, { draftId: 7, reused: true }); assert.equal(generated, false);
  });
  test('a keyword the Analyst does not predict is refused, never generated', async () => {
    let generated = false;
    await assert.rejects(draftForPredictedKeyword(1, 'write me a poem', deps({ generate: async () => { generated = true; return { id: 1 }; } })), (e) => e.status === 404);
    assert.equal(generated, false);
  });
});
