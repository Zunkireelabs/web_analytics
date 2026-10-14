import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let llmCalls;

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => site },
});
mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: {
    analyzePageUrl: async () => ({ ok: false }),
    hasSufficientGroundingContent: () => false,
  },
});
mock.module(resolve('./lib/faq-data-source.js'), {
  namedExports: { findRealFaqDataSource: async () => null },
});
mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLMForJson: async (system, user, opts) => {
      llmCalls.push({ system, user, opts });
      return [{ question: 'Q1', answer: 'A1' }];
    },
  },
});

const { generate } = await import('./faq.js');

beforeEach(() => {
  site = { id: 1 };
  llmCalls = [];
});

describe('faq generator — design context reaches generation', () => {
  test('a site with a real observed "faq" pattern includes it in the prompt', async () => {
    site = {
      id: 1,
      url_file_map: { siteRoot: { designProfile: { pageTypePatterns: {
        faq: { sectionOrder: ['question', 'answer'], textHierarchy: [{ role: 'heading' }], notes: 'this site shows exactly 5 questions per page' },
      } } } },
    };

    await generate({ siteId: 1, params: { topic: 'pricing' } });

    assert.equal(llmCalls.length, 1);
    assert.match(llmCalls[0].user, /question -> answer/);
    assert.match(llmCalls[0].user, /this site shows exactly 5 questions per page/);
  });

  test('no design profile at all still generates — prompt unchanged from before this feature existed', async () => {
    site = { id: 1 };
    await generate({ siteId: 1, params: { topic: 'pricing' } });
    assert.equal(llmCalls.length, 1);
    assert.doesNotMatch(llmCalls[0].user, /section order/i);
  });
});
