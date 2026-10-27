import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shipPromptDraft } from './ai-visibility-ship.js';

const prompt = { id: 5, prompt_text: 'best seo tool for agencies', source: 'top-query' };
const deps = (over = {}) => {
  const calls = { draft: [], error: [] };
  return {
    calls,
    findDraftByTopic: async () => null,
    setPromptDraft: async (siteId, id, draftId) => { calls.draft.push([siteId, id, draftId]); },
    setPromptShipError: async (siteId, id, msg) => { calls.error.push([siteId, id, msg]); },
    generate: async () => ({ id: 42 }),
    ...over,
  };
};

describe('shipPromptDraft', () => {
  test('generates a blog-outline draft grounded in the prompt and links it', async () => {
    let args;
    const d = deps({ generate: async (siteId, a) => { args = a; return { id: 42 }; } });
    const r = await shipPromptDraft(1, prompt, d);
    assert.deepEqual(r, { ok: true, draftId: 42 });
    assert.equal(args.generatorId, 'blog-outline');
    assert.equal(args.params.topic, prompt.prompt_text);
    assert.equal(args.findingId, 'ai-visibility:prompt:5');
    assert.deepEqual(d.calls.draft, [[1, 5, 42]]);
  });

  test('reuses a draft that already covers the topic instead of generating a second post', async () => {
    let generated = false;
    const d = deps({ findDraftByTopic: async () => 9, generate: async () => { generated = true; return { id: 1 }; } });
    const r = await shipPromptDraft(1, prompt, d);
    assert.equal(r.reused, true);
    assert.equal(generated, false);
    assert.deepEqual(d.calls.draft, [[1, 5, 9]]);
  });

  test('a failing generator records the error on the prompt and reports failure', async () => {
    const d = deps({ generate: async () => { throw new Error('design blocked'); } });
    const r = await shipPromptDraft(1, prompt, d);
    assert.equal(r.ok, false);
    assert.deepEqual(d.calls.error, [[1, 5, 'design blocked']]);
    assert.equal(d.calls.draft.length, 0);
  });
});
