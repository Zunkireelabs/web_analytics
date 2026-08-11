import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// meta-title is a SAFE-tier generator (agents/lib/risk-tiers.js), meaning
// auto-remediation.js can draft, approve and push it to a real customer PR
// with no human in the loop — and until now it had no test at all. The
// length-enforcement path below is the specific reason that matters: this
// file's own comment records that 2 of 3 title candidates landed out of
// range on a real run and shipped silently, which is what rewriteToLength
// exists to catch. Nothing verified it actually fires.
const resolve = (p) => new URL(p, import.meta.url).href;

let jsonResponse;      // what callLLMForJson returns (or throws, if an Error)
let rewriteResponses;  // queued callLLM replies, one per rewrite attempt
let rewriteCalls;      // every callLLM invocation, for asserting on/off
let pageAnalysis;      // what analyzePageUrl returns
let sufficientGrounding;

mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLMForJson: async () => {
      if (jsonResponse instanceof Error) throw jsonResponse;
      return jsonResponse;
    },
    callLLM: async (system, user) => {
      rewriteCalls.push({ system, user });
      const next = rewriteResponses.shift();
      // An Error in the queue means "this rewrite call rejects" — the real
      // failure mode rewriteToLength's own .catch(() => null) handles.
      if (next instanceof Error) throw next;
      return next ?? 'unqueued rewrite response';
    },
  },
});

mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: {
    analyzePageUrl: async () => pageAnalysis,
    hasSufficientGroundingContent: () => sufficientGrounding,
  },
});

const { generate, meta } = await import('./meta-title.js');

// Exactly 55 / 155 chars — inside the generator's 50-60 and 150-160 windows,
// so a candidate built from these must never trigger a rewrite call.
const inRangeTitle = 'A'.repeat(55);
const inRangeDescription = 'B'.repeat(155);

beforeEach(() => {
  jsonResponse = { titles: [inRangeTitle], metaDescription: inRangeDescription };
  rewriteResponses = [];
  rewriteCalls = [];
  pageAnalysis = { ok: false };
  sufficientGrounding = false;
});

describe('meta-title generator — contract', () => {
  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'meta-title');
  });

  test('requires query', async () => {
    await assert.rejects(() => generate({ siteId: 1, params: {} }), /query is required/i);
  });

  test('a model response that is not valid JSON fails with a clear 400, not a crash', async () => {
    jsonResponse = new Error('not json');
    await assert.rejects(
      () => generate({ siteId: 1, params: { query: 'best hiking boots' } }),
      (err) => err.status === 400 && /did not return valid JSON/i.test(err.message),
    );
  });

  test('caps at 3 title candidates even when the model returns more', async () => {
    jsonResponse = { titles: Array.from({ length: 6 }, () => inRangeTitle), metaDescription: inRangeDescription };
    const { content } = await generate({ siteId: 1, params: { query: 'best hiking boots' } });
    assert.equal(content.titles.length, 3);
  });

  test('a non-array titles field degrades to an empty list instead of throwing', async () => {
    jsonResponse = { titles: 'not an array', metaDescription: inRangeDescription };
    const { content, summary } = await generate({ siteId: 1, params: { query: 'q' } });
    assert.deepEqual(content.titles, []);
    assert.match(summary, /0 title option/);
  });
});

describe('meta-title generator — length enforcement', () => {
  test('an in-range title and description are returned verbatim, with no rewrite call', async () => {
    const { content } = await generate({ siteId: 1, params: { query: 'best hiking boots' } });
    assert.equal(content.titles[0], inRangeTitle);
    assert.equal(content.metaDescription, inRangeDescription);
    assert.equal(rewriteCalls.length, 0, 'an already-in-range candidate must not burn an extra LLM call');
  });

  test('a too-short title is rewritten — the exact failure this generator documents', async () => {
    jsonResponse = { titles: ['Too short'], metaDescription: inRangeDescription };
    rewriteResponses = [inRangeTitle];
    const { content } = await generate({ siteId: 1, params: { query: 'best hiking boots' } });
    assert.equal(content.titles[0], inRangeTitle);
    assert.equal(rewriteCalls.length, 1);
    assert.match(rewriteCalls[0].system, /between 50 and 60 characters/);
  });

  test('a too-long meta description is rewritten against the 150-160 window', async () => {
    jsonResponse = { titles: [inRangeTitle], metaDescription: 'C'.repeat(400) };
    rewriteResponses = [inRangeDescription];
    const { content } = await generate({ siteId: 1, params: { query: 'q' } });
    assert.equal(content.metaDescription, inRangeDescription);
    assert.equal(rewriteCalls.length, 1);
    assert.match(rewriteCalls[0].system, /between 150 and 160 characters/);
  });

  test('every out-of-range title gets its own rewrite, in-range ones are left alone', async () => {
    jsonResponse = { titles: ['short one', inRangeTitle, 'short two'], metaDescription: inRangeDescription };
    rewriteResponses = ['D'.repeat(55), 'E'.repeat(55)];
    const { content } = await generate({ siteId: 1, params: { query: 'q' } });
    assert.equal(rewriteCalls.length, 2, 'only the 2 out-of-range titles should be rewritten');
    assert.equal(content.titles[1], inRangeTitle, 'the in-range candidate must survive untouched');
  });

  test('a failed rewrite keeps the original candidate rather than dropping it', async () => {
    // rewriteToLength catches and returns null -> enforceLength falls back to
    // the original text. A slightly-out-of-range title is still usable; losing
    // the candidate entirely would leave an empty draft.
    jsonResponse = { titles: ['Too short'], metaDescription: inRangeDescription };
    rewriteResponses = [new Error('model unavailable')];
    const { content } = await generate({ siteId: 1, params: { query: 'q' } });
    assert.equal(content.titles[0], 'Too short');
  });
});

describe('meta-title generator — page grounding', () => {
  test('a page with real content is used as grounding context', async () => {
    pageAnalysis = { ok: true, analysis: { title: 'Existing Title', bodyText: 'Real body content about hiking boots.' } };
    sufficientGrounding = true;
    await generate({ siteId: 1, params: { page: 'https://example.com/boots', query: 'hiking boots' } });
    assert.equal(rewriteCalls.length, 0);
  });

  test('a thin/boilerplate-only page falls back to query-only mode instead of grounding in nav text', async () => {
    // Same "thin extraction treated as a failed fetch" rule the generator
    // documents — the guard is hasSufficientGroundingContent returning false.
    pageAnalysis = { ok: true, analysis: { title: 'T', bodyText: 'Home About Contact Copyright' } };
    sufficientGrounding = false;
    const { content } = await generate({ siteId: 1, params: { page: 'https://example.com/thin', query: 'hiking boots' } });
    assert.equal(content.page, 'https://example.com/thin', 'the page is still recorded on the draft');
    assert.equal(content.titles[0], inRangeTitle);
  });

  test('page is null on the draft when none was requested', async () => {
    const { content } = await generate({ siteId: 1, params: { query: 'q' } });
    assert.equal(content.page, null);
  });
});
