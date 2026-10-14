import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Design-context-reaches-generation coverage for blog-outline.js, same
// convention as landing-page.test.js — every collaborator mocked at the
// module boundary so the test asserts on the PROMPT itself, not on the real
// LLM/network/DB. blog-outline.test.js (the existing file) already covers
// this generator's expand-retry behavior against a real DB + real-shaped
// Anthropic response; this file is narrowly about the one new input.
let site;
let llmCalls;
let llmResponse;

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
mock.module(resolve('./lib/pexels-client.js'), {
  namedExports: {
    searchImage: async () => null,
    buildImageQueries: () => [],
    configured: () => false,
  },
});
mock.module(resolve('./lib/blog-image-usage.js'), {
  namedExports: { usedPhotoIds: async () => new Set() },
});
mock.module(resolve('./lib/blog-image-query.js'), {
  namedExports: { imageQueryContextFor: async () => ({ fallback: 'x' }), IMAGE_CANDIDATE_POOL: 40 },
});
mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLMForJson: async (system, user, opts) => {
      llmCalls.push({ system, user, opts });
      return llmResponse;
    },
  },
});

const { generate } = await import('./blog-outline.js');

beforeEach(() => {
  site = { id: 1 };
  llmCalls = [];
  // 800+ words so no expand pass is triggered — keeps this test about the
  // prompt content, not the expand-retry loop (already covered elsewhere).
  const longBody = Array(820).fill('word').join(' ');
  llmResponse = { title: 'T', metaDescription: 'D', sections: [{ heading: 'H', body: longBody }], suggestedFaqTopics: [], suggestedInternalLinks: [] };
});

describe('blog-outline generator — design context reaches generation', () => {
  test('a site with a real observed "blog-article" pattern includes it in the prompt', async () => {
    site = {
      id: 1,
      url_file_map: { siteRoot: { designProfile: { pageTypePatterns: {
        'blog-article': { sectionOrder: ['intro', 'body', 'conclusion'], textHierarchy: [{ role: 'heading' }], notes: 'always ends with a takeaway' },
      } } } },
    };

    await generate({ siteId: 1, params: { topic: 'A test blog topic' } });

    assert.equal(llmCalls.length, 1);
    assert.match(llmCalls[0].user, /intro -> body -> conclusion/);
    assert.match(llmCalls[0].user, /always ends with a takeaway/);
  });

  test('no design profile at all still generates — prompt unchanged from before this feature existed', async () => {
    site = { id: 1 };
    await generate({ siteId: 1, params: { topic: 'A test blog topic' } });
    assert.equal(llmCalls.length, 1);
    assert.doesNotMatch(llmCalls[0].user, /section order/i);
  });
});
