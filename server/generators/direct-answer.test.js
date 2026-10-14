import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// direct-answer.js imports store/read.js (getSearchPerformanceRange,
// getSiteById), which reaches server/db.js — same real, intentional
// DATABASE_URL-at-import-time check every other DB-importing test file in
// this repo works around the same way (see geo-audit.test.js). Only the
// input-validation path (which throws before any DB call) is exercised
// below, same convention as faq.test.js.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

// Mocks must be registered BEFORE direct-answer.js is first imported —
// node:test's module cache means a later mock.module() call has no effect on
// a module already loaded (this bit the first version of this file: the
// Pexels-sourcing describe below silently kept hitting the real llm.js).
// Mocking unconditionally here is harmless for the plain describe block
// below too, since 'requires query' throws before ever reaching these.
let site;
let getSiteByIdShouldThrow;
let llmJsonResponse;
let pexelsResult;
let pexelsCalls;

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSiteById: async () => { if (getSiteByIdShouldThrow) throw new Error('db unreachable'); return site; },
    getSearchPerformanceRange: async () => [],
  },
});
mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLM: async () => '',
    callLLMForJson: async () => llmJsonResponse,
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
    searchImage: async (queries, opts) => { pexelsCalls.push({ queries, opts }); return pexelsResult; },
    buildImageQueries: ({ title, topic, fallback }) => [title, topic, fallback].filter(Boolean),
    configured: () => true,
  },
});
mock.module(resolve('./lib/blog-image-usage.js'), {
  namedExports: { usedPhotoIds: async () => new Set() },
});
mock.module(resolve('./lib/blog-image-query.js'), {
  namedExports: {
    imageQueryContextFor: async () => ({ topic: null, fallback: undefined }),
    IMAGE_CANDIDATE_POOL: 40,
  },
});

const { generate, meta } = await import('./direct-answer.js');

beforeEach(() => {
  site = null;
  getSiteByIdShouldThrow = false;
  llmJsonResponse = {
    title: 'How long does a boiler last?', heading: 'How long does a boiler last?',
    directAnswer: 'A well-maintained boiler typically lasts '.repeat(10),
    supportingSections: [], suggestedFaqTopics: [], suggestedInternalLinks: [],
  };
  pexelsResult = null;
  pexelsCalls = [];
});

describe('direct-answer generator', () => {
  test('requires query', async () => {
    await assert.rejects(() => generate({ siteId: 1, params: {} }));
  });

  test('meta.id matches the generatorId growth-queries wires into recommendedAction', () => {
    assert.equal(meta.id, 'direct-answer');
  });

  test('has a description', () => {
    assert.ok(meta.description.length > 0);
  });
});

// The user's own ask: any new page this platform generates — not just blog
// posts — should get a real Pexels image the same way blog-outline.js
// already does.
describe('direct-answer generator — Pexels image sourcing (same as blog-outline.js)', () => {
  test('a matched Pexels image is attached to content.featuredImage', async () => {
    site = { id: 1 };
    pexelsResult = { url: 'https://images.pexels.com/photo.jpg', alt: 'A boiler', photographer: 'Jane Doe' };
    const result = await generate({ siteId: 1, params: { query: 'how long does a boiler last' } });
    assert.deepEqual(result.content.featuredImage, pexelsResult);
    assert.equal(pexelsCalls.length, 1);
  });

  test('no match (or search disabled) never blocks the draft — featuredImage is simply absent', async () => {
    site = { id: 1 };
    pexelsResult = null;
    const result = await generate({ siteId: 1, params: { query: 'how long does a boiler last' } });
    assert.equal('featuredImage' in result.content, false);
  });
});
