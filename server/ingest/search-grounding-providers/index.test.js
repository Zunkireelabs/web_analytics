import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// Tavily is the sole search-grounding provider (see index.js's own comment
// for why google-cse/serpapi were removed from this registry). This mocks
// the concrete adapter so tests exercise the real registry logic in
// index.js, not a hand-rolled substitute for it.
let tavilyConfigured = true;
let tavilyBehavior = async () => [{ title: 'Tavily result', url: 'https://example.com/tavily' }];

mock.module('./tavily.js', {
  namedExports: {
    id: 'tavily',
    configured: () => tavilyConfigured,
    searchSources: (...args) => tavilyBehavior(...args),
  },
});

// Regression guard: index.js must not import EITHER of these adapters at
// all any more (they still back competitor-providers/ for real SEO/SERP
// data — untouched — but must never again serve expand-content.js's
// citation-search path). Mocked with a spy that fails the test if it's ever
// even reached, so this catches "someone re-adds a fallback" whether the
// fallback is reached on a Tavily failure OR when Tavily is unconfigured.
let googleCseCalled = false;
let serpapiCalled = false;
mock.module('../competitor-providers/google-cse.js', {
  namedExports: {
    id: 'google-cse',
    configured: () => { googleCseCalled = true; return true; },
    searchSources: async () => { googleCseCalled = true; return [{ title: 'Google CSE result', url: 'https://example.com/google-cse' }]; },
  },
});
mock.module('../competitor-providers/serpapi.js', {
  namedExports: {
    id: 'serpapi',
    configured: () => { serpapiCalled = true; return true; },
    searchSources: async () => { serpapiCalled = true; return [{ title: 'SerpApi result', url: 'https://example.com/serpapi' }]; },
  },
});

const { searchGroundedSources, groundingProviderConfigured } = await import('./index.js');

describe('searchGroundedSources', () => {
  test('returns Tavily results when configured', async () => {
    const sources = await searchGroundedSources('nepal software firms', 3);
    assert.deepEqual(sources, [{ title: 'Tavily result', url: 'https://example.com/tavily' }]);
  });

  test('propagates a Tavily failure (e.g. quota exhausted) rather than falling back to another provider', async () => {
    tavilyBehavior = async () => { throw new Error('Tavily account quota is exhausted for now.'); };

    await assert.rejects(() => searchGroundedSources('nepal software firms', 3), /Tavily account quota is exhausted/);
    assert.equal(googleCseCalled, false, 'must never fall back to Google CSE');
    assert.equal(serpapiCalled, false, 'must never fall back to SerpApi');

    tavilyBehavior = async () => [{ title: 'Tavily result', url: 'https://example.com/tavily' }];
  });

  test('throws when Tavily is not configured, with no other provider to fall back to', async () => {
    tavilyConfigured = false;

    await assert.rejects(() => searchGroundedSources('nepal software firms', 3), /No search-grounding provider is configured/);
    assert.equal(groundingProviderConfigured(), false);
    assert.equal(googleCseCalled, false, 'must never fall back to Google CSE');
    assert.equal(serpapiCalled, false, 'must never fall back to SerpApi');

    tavilyConfigured = true;
  });

  test('never even checks Google CSE / SerpApi configured() on the happy path', async () => {
    await searchGroundedSources('nepal software firms', 3);
    assert.equal(googleCseCalled, false, 'Google CSE configured()/searchSources() must never be invoked from this registry');
    assert.equal(serpapiCalled, false, 'SerpApi configured()/searchSources() must never be invoked from this registry');
  });
});
