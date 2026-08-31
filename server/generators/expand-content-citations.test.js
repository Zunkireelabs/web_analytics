import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Real end-to-end coverage of expand-content.js's external-citations path
// against Tavily, replacing SerpApi/Google CSE. Sets env BEFORE the dynamic
// import below (a static top-level import would be hoisted above these
// assignments and see stale process.env — see the sibling expand-content.
// test.js, which never needs this path enabled and stays a static import).
process.env.ENABLE_CONTENT_CITATION_SEARCH = 'true';
process.env.TAVILY_API_KEY = 'test-key';
process.env.TAVILY_MAX_QUERIES_PER_DAY = '100';

// LLM is fully mocked, same convention as faq.test.js/internal-links.test.js
// (avoids ever importing the real `openai` package in this process — see
// faq.test.js's comment). Captures the actual system/user prompt sent so
// tests can assert the model was really grounded in Tavily's own source
// candidates, not just that *some* LLM call happened.
let lastLlmCall = null;
let llmResponse = [{ heading: 'Further Reading', body: 'See [Real Source](https://real-source.example.com/article) for more.' }];
mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLMForJson: async (system, user, options) => { lastLlmCall = { system, user, options }; return llmResponse; },
  },
});

// Regression guard: neither adapter must ever be reached from this path —
// see search-grounding-providers/index.js's own comment for why they were
// removed. Mocked with call-spies (not left real) so an accidental re-add
// of a fallback fails loudly here too, at the generator's own call site,
// not only in index.test.js's narrower unit coverage.
let googleCseCalled = false;
let serpapiCalled = false;
mock.module(resolve('../ingest/competitor-providers/google-cse.js'), {
  namedExports: {
    id: 'google-cse',
    configured: () => { googleCseCalled = true; return true; },
    searchSources: async () => { googleCseCalled = true; return [{ title: 'Google CSE result', url: 'https://example.com/google-cse' }]; },
  },
});
mock.module(resolve('../ingest/competitor-providers/serpapi.js'), {
  namedExports: {
    id: 'serpapi',
    configured: () => { serpapiCalled = true; return true; },
    searchSources: async () => { serpapiCalled = true; return [{ title: 'SerpApi result', url: 'https://example.com/serpapi' }]; },
  },
});

const { generate } = await import('./expand-content.js');
const { _resetQuotaForTests } = await import('../ingest/search-grounding-providers/tavily.js');

const PAGE_URL = 'https://example.com/citations-page';
const PAGE_HTML = '<html><head><title>Real Page</title></head><body><main><p>'
  + 'Real, substantial page body content about renewable energy policy. '.repeat(10)
  + '</p></main></body></html>';

function mockFetch({ tavilyStatus = 200, tavilyBody, pageOk = true } = {}) {
  let tavilyCall = null;
  const fn = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.tavily.com')) {
      tavilyCall = { url: u, opts, body: opts?.body ? JSON.parse(opts.body) : null };
      return {
        ok: tavilyStatus >= 200 && tavilyStatus < 300,
        status: tavilyStatus,
        json: async () => tavilyBody ?? { results: [] },
      };
    }
    if (u === PAGE_URL) {
      return pageOk
        ? { ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => PAGE_HTML, url: u }
        : { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '', url: u };
    }
    throw new Error(`Unexpected fetch to ${u} in this test`);
  };
  return { fn, getTavilyCall: () => tavilyCall };
}

describe('expand-content generator — external-citations, real path through Tavily', () => {
  test('successful search: calls the real Tavily endpoint (not Google CSE/SerpApi) and grounds the LLM prompt in its results', async () => {
    const original = globalThis.fetch;
    _resetQuotaForTests();
    lastLlmCall = null;
    googleCseCalled = false;
    serpapiCalled = false;
    const { fn, getTavilyCall } = mockFetch({
      tavilyBody: {
        results: [
          { title: 'Real Source', url: 'https://real-source.example.com/article', content: 'A real extracted excerpt about renewable energy.' },
        ],
      },
    });
    globalThis.fetch = fn;
    try {
      const { content, summary } = await generate({ siteId: 1, params: { page: PAGE_URL, query: 'renewable energy policy', focus: 'external-citations' } });

      const tavilyCall = getTavilyCall();
      assert.ok(tavilyCall, 'Tavily endpoint must actually have been called');
      assert.equal(tavilyCall.opts.method, 'POST');
      assert.equal(tavilyCall.opts.headers.Authorization, 'Bearer test-key');
      assert.equal(tavilyCall.body.query, 'renewable energy policy');

      assert.equal(googleCseCalled, false, 'must never call Google CSE for this path');
      assert.equal(serpapiCalled, false, 'must never call SerpApi for this path');

      assert.ok(lastLlmCall, 'LLM must have been called to draft the section');
      assert.match(lastLlmCall.user, /Real Source: https:\/\/real-source\.example\.com\/article/);
      assert.match(lastLlmCall.user, /Excerpt: A real extracted excerpt about renewable energy\./);

      assert.equal(content.focus, 'external-citations');
      assert.equal(content.sections.length, 1);
      assert.match(summary, /external-citations/);
    } finally { globalThis.fetch = original; }
  });

  test('missing TAVILY_API_KEY: refuses honestly, never calls Google CSE/SerpApi, never fabricates a citation', async () => {
    const original = globalThis.fetch;
    const originalKey = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    googleCseCalled = false;
    serpapiCalled = false;
    let fetchCalled = false;
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('https://api.tavily.com')) fetchCalled = true;
      if (String(url) === PAGE_URL) return { ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => PAGE_HTML, url };
      throw new Error('unexpected fetch');
    };
    try {
      await assert.rejects(
        () => generate({ siteId: 1, params: { page: PAGE_URL, focus: 'external-citations' } }),
        (err) => {
          assert.equal(err.refusal, true);
          assert.equal(err.reason, 'citation-grounding-not-configured');
          assert.equal(err.userFacing, true);
          return true;
        },
      );
      assert.equal(fetchCalled, false, 'must not call Tavily when unconfigured');
      assert.equal(googleCseCalled, false);
      assert.equal(serpapiCalled, false);
    } finally {
      globalThis.fetch = original;
      process.env.TAVILY_API_KEY = originalKey;
    }
  });

  test('Tavily failure (network/outage): records an honest refusal, not a fabricated citation, and never falls back', async () => {
    const original = globalThis.fetch;
    _resetQuotaForTests();
    googleCseCalled = false;
    serpapiCalled = false;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('https://api.tavily.com')) throw new Error('simulated network failure');
      if (u === PAGE_URL) return { ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => PAGE_HTML, url: u };
      throw new Error('unexpected fetch');
    };
    try {
      await assert.rejects(
        () => generate({ siteId: 1, params: { page: PAGE_URL, focus: 'external-citations' } }),
        (err) => {
          assert.equal(err.refusal, true);
          assert.equal(err.reason, 'citation-grounding-unavailable');
          return true;
        },
      );
      assert.equal(googleCseCalled, false);
      assert.equal(serpapiCalled, false);
    } finally { globalThis.fetch = original; }
  });

  test('Tavily quota/rate-limit response (432): records an honest refusal, does not retry, does not fall back', async () => {
    const original = globalThis.fetch;
    _resetQuotaForTests();
    googleCseCalled = false;
    serpapiCalled = false;
    let tavilyCallCount = 0;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('https://api.tavily.com')) {
        tavilyCallCount += 1;
        return { ok: false, status: 432, json: async () => ({ detail: { error: 'plan limit exceeded' } }) };
      }
      if (u === PAGE_URL) return { ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => PAGE_HTML, url: u };
      throw new Error('unexpected fetch');
    };
    try {
      await assert.rejects(
        () => generate({ siteId: 1, params: { page: PAGE_URL, focus: 'external-citations' } }),
        (err) => {
          assert.equal(err.refusal, true);
          assert.equal(err.reason, 'citation-grounding-unavailable');
          return true;
        },
      );
      assert.equal(tavilyCallCount, 1, 'must not retry a quota-exhausted response');
      assert.equal(googleCseCalled, false);
      assert.equal(serpapiCalled, false);
    } finally { globalThis.fetch = original; }
  });

  test('no source candidates found: refuses honestly rather than drafting an ungrounded citations section', async () => {
    const original = globalThis.fetch;
    _resetQuotaForTests();
    const { fn } = mockFetch({ tavilyBody: { results: [] } });
    globalThis.fetch = fn;
    try {
      await assert.rejects(
        () => generate({ siteId: 1, params: { page: PAGE_URL, focus: 'external-citations' } }),
        (err) => {
          assert.equal(err.refusal, true);
          assert.equal(err.reason, 'citation-grounding-no-sources');
          return true;
        },
      );
    } finally { globalThis.fetch = original; }
  });

  // The strict daily cap itself (TAVILY_MAX_QUERIES_PER_DAY) is a
  // load-time constant read once when tavily.js's module graph first
  // loads (same convention as e.g. ship-window.js's SHIP_HOUR_LOCAL) — it
  // can't be changed mid-process, so its enforcement is covered with a
  // correctly-ordered env-before-import setup in tavily.test.js instead.
  // What matters here is that generate() surfaces that refusal honestly
  // when it happens, which the quota-response test above already exercises
  // via Tavily's own 432 response.
});
