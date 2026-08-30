import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// Regression coverage for a real, systemic failure: with only
// getConfiguredGroundingProvider() (no fallback), a single configured
// provider (serpapi, listed first — see index.js's own comment) whose quota
// was exhausted or which had a transient outage made EVERY
// expand-content::external-citations run fail identically, across many
// unrelated pages on the same day, even though google-cse was also
// configured and could have served the request. mock.module swaps both
// concrete provider adapters so this exercises the real fallback logic in
// index.js, not a hand-rolled substitute for it.
let serpapiConfigured = true;
let serpapiBehavior = async () => { throw new Error('SerpApi is temporarily unavailable (rate limited).'); };
let googleCseConfigured = true;
let googleCseBehavior = async () => [{ title: 'Google result', url: 'https://example.com/google' }];

mock.module('../competitor-providers/serpapi.js', {
  namedExports: {
    id: 'serpapi',
    configured: () => serpapiConfigured,
    searchSources: (...args) => serpapiBehavior(...args),
  },
});
mock.module('../competitor-providers/google-cse.js', {
  namedExports: {
    id: 'google-cse',
    configured: () => googleCseConfigured,
    searchSources: (...args) => googleCseBehavior(...args),
  },
});

const { searchGroundedSources, groundingProviderConfigured } = await import('./index.js');

describe('searchGroundedSources', () => {
  test('falls back to the next configured provider when the first one throws', async () => {
    const sources = await searchGroundedSources('nepal software firms', 3);
    assert.deepEqual(sources, [{ title: 'Google result', url: 'https://example.com/google' }]);
  });

  test('does not fall back when the first configured provider succeeds', async () => {
    let googleCalled = false;
    serpapiBehavior = async () => [{ title: 'SerpApi result', url: 'https://example.com/serpapi' }];
    googleCseBehavior = async () => { googleCalled = true; return []; };

    const sources = await searchGroundedSources('nepal software firms', 3);
    assert.deepEqual(sources, [{ title: 'SerpApi result', url: 'https://example.com/serpapi' }]);
    assert.equal(googleCalled, false);
  });

  test('throws the last error when every configured provider fails', async () => {
    serpapiBehavior = async () => { throw new Error('serpapi down'); };
    googleCseBehavior = async () => { throw new Error('google-cse down'); };

    await assert.rejects(() => searchGroundedSources('nepal software firms', 3), /google-cse down/);
  });

  test('skips an unconfigured provider entirely rather than trying and failing it', async () => {
    serpapiConfigured = false;
    googleCseConfigured = true;
    googleCseBehavior = async () => [{ title: 'Google result', url: 'https://example.com/google' }];

    const sources = await searchGroundedSources('nepal software firms', 3);
    assert.deepEqual(sources, [{ title: 'Google result', url: 'https://example.com/google' }]);

    serpapiConfigured = true;
  });

  test('throws when no provider is configured at all', async () => {
    serpapiConfigured = false;
    googleCseConfigured = false;

    await assert.rejects(() => searchGroundedSources('nepal software firms', 3), /No search-grounding provider is configured/);
    assert.equal(groundingProviderConfigured(), false);

    serpapiConfigured = true;
    googleCseConfigured = true;
  });
});
