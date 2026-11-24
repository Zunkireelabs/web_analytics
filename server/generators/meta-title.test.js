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
let jsonQueue;         // optional: successive callLLMForJson replies (shifted per call) — for the retry path
let jsonCalls;         // every callLLMForJson system prompt
let siteRow;           // what getSiteById returns

mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLMForJson: async (system) => {
      jsonCalls.push(system);
      if (jsonQueue.length) return jsonQueue.shift();
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

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => siteRow },
});

mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: {
    analyzePageUrl: async () => pageAnalysis,
    hasSufficientGroundingContent: () => sufficientGrounding,
  },
});

const { generate, meta, verifyCurrentState, flaggedDuplicateTitle } = await import('./meta-title.js');

// Exactly 55 / 155 chars — inside the generator's 50-60 and 150-160 windows,
// so a candidate built from these must never trigger a rewrite call.
const inRangeTitle = 'A'.repeat(55);
const inRangeDescription = 'B'.repeat(155);

beforeEach(() => {
  jsonResponse = { titles: [inRangeTitle], metaDescription: inRangeDescription };
  rewriteResponses = [];
  rewriteCalls = [];
  jsonQueue = [];
  jsonCalls = [];
  siteRow = null;
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

describe('meta-title generator — per-site titleClaimBans', () => {
  const bannedSite = { url_file_map: { siteRoot: { titleClaimBans: ['consultancy'] } } };
  const cleanTitle = 'C'.repeat(55);

  test('the prompt names the banned words', async () => {
    siteRow = bannedSite;
    await generate({ siteId: 1, params: { query: 'q' } });
    assert.match(jsonCalls[0], /Never use any of these words[^.]*"consultancy"/);
  });

  test('a banned word triggers one retry, and the clean second answer is used', async () => {
    siteRow = bannedSite;
    jsonQueue = [
      { titles: ['consultancy ' + 'A'.repeat(44)], metaDescription: inRangeDescription },
      { titles: [cleanTitle], metaDescription: inRangeDescription },
    ];
    const { content } = await generate({ siteId: 1, params: { query: 'q' } });
    assert.deepEqual(content.titles, [cleanTitle]);
    assert.equal(jsonCalls.length, 2);
    assert.match(jsonCalls[1], /previous answer used a word this site does not allow/);
  });

  test('a description that still carries the word after the retry fails loudly instead of shipping', async () => {
    siteRow = bannedSite;
    const bad = { titles: [cleanTitle], metaDescription: 'A study abroad consultancy ' + 'B'.repeat(130) };
    jsonQueue = [bad, bad];
    await assert.rejects(() => generate({ siteId: 1, params: { query: 'q' } }), (err) => err.status === 400 && /does not allow/.test(err.message));
  });

  test('a blog post (article-like page) is exempt, so no ban prompt and no retry', async () => {
    siteRow = bannedSite;
    pageAnalysis = { ok: true, analysis: { title: 't', metaDescription: 'd', bodyText: 'x'.repeat(500), isArticlePage: true } };
    sufficientGrounding = true;
    jsonResponse = { titles: ['consultancy ' + 'A'.repeat(44)], metaDescription: inRangeDescription };
    const { content } = await generate({ siteId: 1, params: { query: 'q', page: 'https://x.test/blog/post' } });
    assert.match(content.titles[0], /consultancy/);
    assert.equal(jsonCalls.length, 1);
    assert.doesNotMatch(jsonCalls[0], /Never use any of these words/);
  });

  test('a blog post that is not published yet (page cannot be read) is exempt by the site\'s own blog URL pattern', async () => {
    siteRow = { url_file_map: { siteRoot: { titleClaimBans: ['consultancy'] }, newContentTargets: { 'blog-outline': { urlPattern: '/blogs/{slug}' } } } };
    pageAnalysis = { ok: false };
    jsonResponse = { titles: ['consultancy ' + 'A'.repeat(44)], metaDescription: inRangeDescription };
    const { content } = await generate({ siteId: 1, params: { query: 'q', page: 'https://x.test/blogs/draft-post' } });
    assert.match(content.titles[0], /consultancy/);
    assert.equal(jsonCalls.length, 1);
    assert.doesNotMatch(jsonCalls[0], /Never use any of these words/);
  });

  test('an unpublished page that is NOT under the blog pattern is still banned', async () => {
    siteRow = { url_file_map: { siteRoot: { titleClaimBans: ['consultancy'] }, newContentTargets: { 'blog-outline': { urlPattern: '/blogs/{slug}' } } } };
    pageAnalysis = { ok: false };
    await generate({ siteId: 1, params: { query: 'q', page: 'https://x.test/new-landing' } });
    assert.match(jsonCalls[0], /Never use any of these words/);
  });

  test('no page URL and no declared type: the ban stays on, and the summary says why', async () => {
    siteRow = bannedSite;
    const { summary } = await generate({ siteId: 1, params: { query: 'q' } });
    assert.match(jsonCalls[0], /Never use any of these words/);
    assert.match(summary, /page type could not be identified/);
  });

  test('no page URL but pageType "blog": exempt, no ban prompt, no caution note', async () => {
    siteRow = bannedSite;
    jsonResponse = { titles: ['consultancy ' + 'A'.repeat(44)], metaDescription: inRangeDescription };
    const { content, summary } = await generate({ siteId: 1, params: { query: 'q', pageType: 'blog' } });
    assert.match(content.titles[0], /consultancy/);
    assert.doesNotMatch(jsonCalls[0], /Never use any of these words/);
    assert.doesNotMatch(summary, /could not be identified/);
  });

  test('a declared "landing-page" with no URL is a RESOLVED type: still banned, and not called unknown', async () => {
    siteRow = bannedSite;
    const { summary } = await generate({ siteId: 1, params: { query: 'q', pageType: 'landing-page' } });
    assert.match(jsonCalls[0], /Never use any of these words/);
    assert.doesNotMatch(summary, /could not be identified/);
  });

  test('the caution note never goes into content, which the apply step reads', async () => {
    siteRow = bannedSite;
    const { content } = await generate({ siteId: 1, params: { query: 'q' } });
    assert.deepEqual(Object.keys(content).sort(), ['metaDescription', 'page', 'query', 'titles']);
  });

  test('a site with no titleClaimBans is unaffected', async () => {
    siteRow = { url_file_map: { siteRoot: {} } };
    jsonResponse = { titles: ['consultancy ' + 'A'.repeat(44)], metaDescription: inRangeDescription };
    const { content } = await generate({ siteId: 1, params: { query: 'q' } });
    assert.match(content.titles[0], /consultancy/);
    assert.equal(jsonCalls.length, 1);
  });
});

describe('meta-title generator — a new title must differ from the one the page has', () => {
  const current = inRangeTitle; // in range, so no length rewrite changes it
  const other = 'D'.repeat(55);
  beforeEach(() => { pageAnalysis = { ok: true, analysis: { title: current, metaDescription: 'old', bodyText: 'x' } }; });

  test('an option identical to the current title is dropped, the others are kept', async () => {
    jsonResponse = { titles: [current, other], metaDescription: inRangeDescription };
    const { content } = await generate({ siteId: 1, params: { query: 'q', page: 'https://x.test/p/' } });
    assert.deepEqual(content.titles, [other]);
  });
  test('when every option is the current title the model gets one corrective retry', async () => {
    jsonQueue = [{ titles: [current], metaDescription: inRangeDescription }, { titles: [other], metaDescription: inRangeDescription }];
    const { content } = await generate({ siteId: 1, params: { query: 'q', page: 'https://x.test/p/' } });
    assert.deepEqual(content.titles, [other]);
    assert.equal(jsonCalls.length, 2);
    assert.match(jsonCalls[1], /identical to the page's current title/);
  });
  test('still identical after the retry: refused, never shipped as a no-op', async () => {
    jsonQueue = [{ titles: [current], metaDescription: inRangeDescription }, { titles: [current], metaDescription: inRangeDescription }];
    await assert.rejects(() => generate({ siteId: 1, params: { query: 'q', page: 'https://x.test/p/' } }), /matched the title the page already has/);
  });
});

describe('meta-title verifyCurrentState — the duplicate-title finding', () => {
  const reason = '"Gemma 4: Was ein offenes Modell" is used as the title on 2 different pages — search engines can\'t tell them apart';
  const rec = { reason, params: { page: 'https://x.test/p/' } };
  test('reads the flagged title out of the finding', () => assert.equal(flaggedDuplicateTitle(reason), 'Gemma 4: Was ein offenes Modell'));
  test('a CTR/growth finding is not a duplicate-title finding', () => assert.equal(flaggedDuplicateTitle('Ranks #8.5 with 231 impressions'), null));
  test('the live title is no longer the flagged one: already resolved', async () => {
    pageAnalysis = { ok: true, analysis: { title: 'A different, unique title' } };
    const v = await verifyCurrentState(rec, {});
    assert.equal(v.decision, 'already_resolved');
    assert.equal(v.reason, 'duplicate-title-already-changed');
  });
  test('the live title is still the flagged one (case and spacing aside): still valid', async () => {
    pageAnalysis = { ok: true, analysis: { title: '  gemma 4:  was ein offenes   modell ' } };
    assert.equal((await verifyCurrentState(rec, {})).decision, 'still_valid');
  });
  test('page unreachable: says nothing, stays valid', async () => {
    pageAnalysis = { ok: false, error: 'timeout' };
    assert.equal((await verifyCurrentState(rec, {})).reason, 'unreachable');
  });
  test('a finding that is not about a duplicate title is left to the generator', async () => {
    assert.equal((await verifyCurrentState({ reason: 'low CTR', params: { page: 'https://x.test/' } }, {})).decision, 'still_valid');
  });
});
