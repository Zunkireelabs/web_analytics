import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// internal-links is a SAFE-tier generator (agents/lib/risk-tiers.js): the
// auto-remediation loop can draft, approve and push it into a real customer
// PR with no human review. Its one genuinely load-bearing safety property is
// the candidateSet filter — the model is handed a list of real ranking URLs
// and told to pick from it, and any targetUrl it invents anyway must be
// dropped rather than written into the customer's HTML as a dead link.
// Nothing tested that until now.
//
// site-domain.js is deliberately NOT mocked — its real hostname filtering is
// part of what decides the candidate set, so mocking it would test a
// candidate list this generator would never actually be given.
const resolve = (p) => new URL(p, import.meta.url).href;

let llmResponse;   // array, or an Error to reject with
let pageFetch;
let rankingPages;

mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLMForJson: async () => {
      if (llmResponse instanceof Error) throw llmResponse;
      return llmResponse;
    },
  },
});

mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: {
    analyzePageUrl: async () => pageFetch,
    requireGroundedContent: () => {},
  },
});

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSiteById: async () => ({ id: 1, website_domain: 'example.com' }),
    getSearchPerformanceRange: async () => rankingPages,
  },
});

const { generate, meta } = await import('./internal-links.js');

const SOURCE = 'https://example.com/source';

beforeEach(() => {
  pageFetch = { ok: true, analysis: { bodyText: 'Real body text about hiking boots and trail maintenance.' } };
  rankingPages = [
    { dim_value: 'https://example.com/boots' },
    { dim_value: 'https://example.com/trails' },
    { dim_value: SOURCE },
  ];
  llmResponse = [
    { anchorText: 'hiking boots', targetUrl: 'https://example.com/boots', rationale: 'r' },
  ];
});

describe('internal-links generator — contract', () => {
  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'internal-links');
  });

  test('requires page', async () => {
    await assert.rejects(() => generate({ siteId: 1, params: {} }), /page is required/i);
  });

  test('an unfetchable page fails with a clear 400 rather than drafting blind', async () => {
    pageFetch = { ok: false, error: 'HTTP 404' };
    await assert.rejects(
      () => generate({ siteId: 1, params: { page: SOURCE } }),
      (err) => err.status === 400 && /Could not fetch page: HTTP 404/.test(err.message),
    );
  });

  test('a model response that is not valid JSON fails with a clear 400', async () => {
    llmResponse = new Error('bad json');
    await assert.rejects(
      () => generate({ siteId: 1, params: { page: SOURCE } }),
      (err) => err.status === 400 && /did not return valid JSON/i.test(err.message),
    );
  });

  test('a JSON object (not an array) is rejected the same way', async () => {
    llmResponse = { anchorText: 'x', targetUrl: 'https://example.com/boots' };
    await assert.rejects(
      () => generate({ siteId: 1, params: { page: SOURCE } }),
      (err) => err.status === 400,
    );
  });
});

describe('internal-links generator — candidate selection', () => {
  test('the source page is never offered as a link target to itself', async () => {
    llmResponse = [{ anchorText: 'self', targetUrl: SOURCE, rationale: 'r' }];
    const { content } = await generate({ siteId: 1, params: { page: SOURCE } });
    assert.deepEqual(content.suggestions, []);
    assert.equal(content.droppedHallucinated, 1);
  });

  test('off-domain ranking rows are excluded from the candidate pool', async () => {
    rankingPages = [{ dim_value: 'https://competitor.com/boots' }];
    const { content, summary } = await generate({ siteId: 1, params: { page: SOURCE } });
    assert.deepEqual(content.suggestions, []);
    assert.match(content.note, /No other ranking pages/i);
    assert.match(summary, /No internal link candidates/i);
  });

  test('with no candidates it returns an empty draft instead of calling the model', async () => {
    rankingPages = [];
    const { content } = await generate({ siteId: 1, params: { page: SOURCE } });
    assert.deepEqual(content.suggestions, []);
    assert.ok('note' in content);
  });
});

describe('internal-links generator — hallucinated URL rejection', () => {
  test('a targetUrl not in the real candidate list is dropped, not written into the page', async () => {
    llmResponse = [
      { anchorText: 'real', targetUrl: 'https://example.com/boots', rationale: 'r' },
      { anchorText: 'invented', targetUrl: 'https://example.com/does-not-exist', rationale: 'r' },
    ];
    const { content, summary } = await generate({ siteId: 1, params: { page: SOURCE } });
    assert.equal(content.suggestions.length, 1);
    assert.equal(content.suggestions[0].targetUrl, 'https://example.com/boots');
    assert.equal(content.droppedHallucinated, 1);
    assert.match(summary, /1 dropped — not a real candidate URL/);
  });

  test('a near-miss URL is dropped too — matching is exact, not fuzzy', async () => {
    // A trailing slash or a http:// variant is still not the URL that was
    // offered, and linking to it can still 404 on the live site.
    llmResponse = [
      { anchorText: 'a', targetUrl: 'https://example.com/boots/', rationale: 'r' },
      { anchorText: 'b', targetUrl: 'http://example.com/boots', rationale: 'r' },
    ];
    const { content } = await generate({ siteId: 1, params: { page: SOURCE } });
    assert.deepEqual(content.suggestions, []);
    assert.equal(content.droppedHallucinated, 2);
  });

  test('a suggestion with no anchorText is dropped even when its URL is real', async () => {
    llmResponse = [{ targetUrl: 'https://example.com/boots', rationale: 'r' }];
    const { content } = await generate({ siteId: 1, params: { page: SOURCE } });
    assert.deepEqual(content.suggestions, []);
    assert.equal(content.droppedHallucinated, 1);
  });

  test('a null entry in the model array does not crash the filter', async () => {
    llmResponse = [null, { anchorText: 'real', targetUrl: 'https://example.com/boots', rationale: 'r' }];
    const { content } = await generate({ siteId: 1, params: { page: SOURCE } });
    assert.equal(content.suggestions.length, 1);
  });

  test('caps at 5 suggestions even when every one is valid', async () => {
    rankingPages = Array.from({ length: 8 }, (_, i) => ({ dim_value: `https://example.com/p${i}` }));
    llmResponse = Array.from({ length: 8 }, (_, i) => ({ anchorText: `a${i}`, targetUrl: `https://example.com/p${i}`, rationale: 'r' }));
    const { content } = await generate({ siteId: 1, params: { page: SOURCE } });
    assert.equal(content.suggestions.length, 5);
    assert.equal(content.droppedHallucinated, 0, 'a cap is not a hallucination — droppedHallucinated must stay 0');
  });
});
