import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// Real store/read.js transitively pulls in the OpenAI SDK (via
// candidate-pages.js's own other imports), which hits the same unrelated
// ESM/CJS web-streams-polyfill incompatibility under
// --experimental-test-module-mocks documented in visual-quality.test.js —
// stub only the exports actually reachable here, rather than importing the
// real module. getSearchPerformanceRange/getSiteById are only imported
// (never called) by candidate-pages.js's own module graph: run()'s
// params.pages path below skips selectCandidatePages entirely, so these
// two are dead weight this test never invokes — present only so the
// static import resolves.
mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSearchPerformanceForPages: async (siteId, start, end, pages) => pages.map((p) => ({ dim_value: p, impressions: 0 })),
    getSearchPerformanceRange: async () => [],
    getSiteById: async () => null,
  },
});
// llm.js imports the real OpenAI SDK, which hits the same web-streams-
// polyfill incompatibility the moment ANY mock.module call is active in
// this process (documented in visual-quality.test.js) — stub callLLM
// (content-integrity.js's only narrative-summary call, unrelated to what
// this test verifies) so the real SDK is never loaded at all.
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => 'stub narrative' },
});

const { run, findInconsistentFaqQuestions } = await import('./content-integrity.js');

function page(url, items) {
  return { page: url, analysis: { faqVisibleItems: items } };
}

describe('findInconsistentFaqQuestions', () => {
  test('flags the same real question answered differently on two different pages', () => {
    const reachable = [
      page('https://example.com/a', [{ question: 'When do you ship?', answer: 'Within 2 business days.' }]),
      page('https://example.com/b', [{ question: 'When do you ship?', answer: 'Within 5 business days.' }]),
    ];
    const result = findInconsistentFaqQuestions(reachable);
    assert.equal(result.length, 1);
    assert.equal(result[0].question, 'when do you ship?');
    assert.equal(result[0].variants.length, 2);
  });

  test('does not flag the same question with the same real answer (whitespace/case-insensitive)', () => {
    const reachable = [
      page('https://example.com/a', [{ question: 'When do you ship?', answer: 'Within 2 business days.' }]),
      page('https://example.com/b', [{ question: '  When Do You Ship?  ', answer: '  within 2   business days.  ' }]),
    ];
    assert.deepEqual(findInconsistentFaqQuestions(reachable), []);
  });

  test('ignores items with no confidently-extracted answer', () => {
    const reachable = [
      page('https://example.com/a', [{ question: 'When do you ship?', answer: null }]),
      page('https://example.com/b', [{ question: 'When do you ship?', answer: 'Within 2 business days.' }]),
    ];
    assert.deepEqual(findInconsistentFaqQuestions(reachable), []);
  });

  test('does not flag a question that only appears on one page', () => {
    const reachable = [
      page('https://example.com/a', [{ question: 'When do you ship?', answer: 'Within 2 business days.' }]),
      page('https://example.com/b', [{ question: 'Do you ship internationally?', answer: 'Yes, worldwide.' }]),
    ];
    assert.deepEqual(findInconsistentFaqQuestions(reachable), []);
  });

  test('empty input -> empty result', () => {
    assert.deepEqual(findInconsistentFaqQuestions([]), []);
  });
});

// The concurrency cap (2026-09-01 audit follow-up): MAX_PAGES=100 must never
// mean 100 simultaneous requests against one tenant's host. Uses run()'s own
// params.pages/pageCache injection seam (no module mocking needed for the
// fetch layer itself) so this exercises the REAL pLimit wiring, not a stand-in.
describe('content-integrity fetch concurrency', () => {
  test('never runs more than CONTENT_INTEGRITY_FETCH_CONCURRENCY (default 10) fetches at once', async () => {
    const pages = Array.from({ length: 40 }, (_, i) => `https://example.com/p${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const pageCache = async (page) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5)); // force real overlap, not accidental seriality
      inFlight--;
      return { ok: true, analysis: { malformedTableCount: 0, faqVisibleItems: [] } };
    };

    await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages } });

    assert.ok(maxInFlight <= 10, `expected at most 10 concurrent fetches, saw ${maxInFlight}`);
    assert.ok(maxInFlight > 1, 'sanity check: fetches must still run concurrently, not fall back to serial');
  });

  test('CONTENT_INTEGRITY_FETCH_CONCURRENCY overrides the default, read fresh on every call', async () => {
    const pages = Array.from({ length: 20 }, (_, i) => `https://example.com/p${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const pageCache = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { ok: true, analysis: { malformedTableCount: 0, faqVisibleItems: [] } };
    };

    process.env.CONTENT_INTEGRITY_FETCH_CONCURRENCY = '3';
    try {
      await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages } });
    } finally {
      delete process.env.CONTENT_INTEGRITY_FETCH_CONCURRENCY;
    }

    assert.ok(maxInFlight <= 3, `expected at most 3 concurrent fetches with the override set, saw ${maxInFlight}`);
  });
});
