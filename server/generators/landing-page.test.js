import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Design-context-reaches-generation coverage. Everything the generator talks
// to is mocked at the module boundary — same convention as auto-remediation
// .test.js — so this proves the PROMPT actually carries the site's real
// structural guidance, not just that rendering restyles whatever the LLM
// happened to invent (that half is newpage-render.test.js's job).
let site;
let llmCalls;
let llmResponse;
let getSiteByIdShouldThrow;
let pexelsResult;
let pexelsCalls;

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => { if (getSiteByIdShouldThrow) throw new Error('db unreachable'); return site; } },
});
mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLMForJson: async (system, user, opts) => {
      llmCalls.push({ system, user, opts });
      return llmResponse;
    },
  },
});
// Real pexels-client.js/blog-image-usage.js hit the network/DB — mocked here
// the same way blog-outline.test.js mocks them, so this test only proves the
// generator WIRES the search in and passes its result through, not that
// Pexels itself works (pexels-client.test.js already covers that).
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

const { generate, meta } = await import('./landing-page.js');

beforeEach(() => {
  site = null;
  llmCalls = [];
  getSiteByIdShouldThrow = false;
  llmResponse = { headline: 'Grow in Austin', subheadline: 'sub', sections: [{ heading: 'h', body: 'b' }], cta: 'Start', metaTitle: 'mt', metaDescription: 'md' };
  pexelsResult = null;
  pexelsCalls = [];
});

describe('landing-page generator — meta', () => {
  test('meta.id is stable', () => {
    assert.equal(meta.id, 'landing-page');
  });

  test('requires a target', async () => {
    await assert.rejects(() => generate({ siteId: 1, params: {} }));
  });
});

describe('landing-page generator — design context reaches generation', () => {
  test('a site with a real observed "landing" pattern includes it in the prompt', async () => {
    site = {
      url_file_map: { siteRoot: { designProfile: { pageTypePatterns: {
        landing: { sectionOrder: ['hero', 'features', 'pricing', 'cta'], textHierarchy: [{ role: 'heading' }, { role: 'body' }], notes: 'one CTA button, never two' },
      } } } },
    };

    await generate({ siteId: 1, params: { city: 'Austin' } });

    assert.equal(llmCalls.length, 1);
    assert.match(llmCalls[0].user, /hero -> features -> pricing -> cta/);
    assert.match(llmCalls[0].user, /one CTA button, never two/);
  });

  test('no landing pattern falls back to service, then homepage', async () => {
    site = {
      url_file_map: { siteRoot: { designProfile: { pageTypePatterns: {
        homepage: { sectionOrder: ['hero', 'social-proof'], textHierarchy: [{ role: 'heading' }] },
      } } } },
    };

    await generate({ siteId: 1, params: { city: 'Austin' } });
    assert.match(llmCalls[0].user, /"homepage" pages/);
    assert.match(llmCalls[0].user, /hero -> social-proof/);
  });

  test('a site with no design profile at all still generates — prompt unchanged from before this feature existed', async () => {
    site = { id: 1 };
    await generate({ siteId: 1, params: { city: 'Austin' } });
    assert.equal(llmCalls.length, 1);
    assert.doesNotMatch(llmCalls[0].user, /section order/i);
  });

  test('getSiteById failing never blocks generation — fails open to the pre-existing prompt', async () => {
    getSiteByIdShouldThrow = true;
    const result = await generate({ siteId: 1, params: { city: 'Austin' } });
    assert.ok(result.content.headline);
    assert.doesNotMatch(llmCalls[0].user, /section order/i);
  });
});

describe('landing-page generator — content shape (unchanged)', () => {
  test('never fabricates content beyond what the model returned', async () => {
    site = { id: 1 };
    const result = await generate({ siteId: 1, params: { market: 'Texas' } });
    assert.equal(result.content.headline, 'Grow in Austin');
    assert.equal(result.content.target, 'Texas');
    assert.deepEqual(result.content.sections, [{ heading: 'h', body: 'b' }]);
  });
});

// The user's own ask: any new page this platform generates — not just blog
// posts — should get a real Pexels image the same way blog-outline.js
// already does, so a freshly created page never looks unfinished next to
// the site's other real pages.
describe('landing-page generator — Pexels image sourcing (same as blog-outline.js)', () => {
  test('a matched Pexels image is attached to content.featuredImage', async () => {
    site = { id: 1 };
    pexelsResult = { url: 'https://images.pexels.com/photo.jpg', alt: 'A city skyline', photographer: 'Jane Doe' };
    const result = await generate({ siteId: 1, params: { market: 'Texas' } });
    assert.deepEqual(result.content.featuredImage, pexelsResult);
    assert.equal(pexelsCalls.length, 1);
  });

  test('no match (or search disabled) never blocks the draft — featuredImage is simply absent', async () => {
    site = { id: 1 };
    pexelsResult = null;
    const result = await generate({ siteId: 1, params: { market: 'Texas' } });
    assert.equal('featuredImage' in result.content, false);
  });
});
