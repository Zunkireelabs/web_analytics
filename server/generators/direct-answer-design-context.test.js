import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let llmCalls;

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSiteById: async () => site,
    getSearchPerformanceRange: async () => [],
  },
});
mock.module(resolve('../agents/lib/site-domain.js'), {
  namedExports: {
    knownDomain: () => null,
    ownDomains: () => [],
    filterOwnDomainPages: () => [],
  },
});
mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: {
    analyzePageUrl: async () => ({ ok: false }),
    hasSufficientGroundingContent: () => false,
  },
});
mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLM: async () => '',
    callLLMForJson: async (system, user, opts) => {
      llmCalls.push({ system, user, opts });
      return { title: 'T', heading: 'H', directAnswer: Array(150).fill('word').join(' '), supportingSections: [], suggestedFaqTopics: [], suggestedInternalLinks: [] };
    },
  },
});

const { generate } = await import('./direct-answer.js');

beforeEach(() => {
  site = { id: 1 };
  llmCalls = [];
});

describe('direct-answer generator — design context reaches generation', () => {
  test('a site with a real observed "faq" pattern includes it in the prompt', async () => {
    site = {
      id: 1,
      url_file_map: { siteRoot: { designProfile: { pageTypePatterns: {
        faq: { sectionOrder: ['question', 'answer'], textHierarchy: [{ role: 'heading' }], notes: 'answers stay under 150 words' },
      } } } },
    };

    await generate({ siteId: 1, params: { query: 'how does this work' } });

    assert.equal(llmCalls.length, 1);
    assert.match(llmCalls[0].user, /question -> answer/);
    assert.match(llmCalls[0].user, /answers stay under 150 words/);
  });

  test('no design profile at all still generates — prompt unchanged from before this feature existed', async () => {
    site = { id: 1 };
    await generate({ siteId: 1, params: { query: 'how does this work' } });
    assert.equal(llmCalls.length, 1);
    assert.doesNotMatch(llmCalls[0].user, /section order/i);
  });
});
