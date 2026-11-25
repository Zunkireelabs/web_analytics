import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta , internalLinkCount, keepIfMoreLinks } from './blog-outline.js';
import { query, pool } from '../db.js';
// The verified-sources step makes its own model call and page fetches; these tests count model calls for other behaviour, so it is switched off here (it has its own tests: lib/verified-sources.test.js).
process.env.BLOG_SOURCES = 'off';

// This file is about the expand-retry loop and stubs the global fetch for the model. The SERP lookup (lib/serp.js) is not part of that, and
// must never run against a stubbed fetch or a developer's real search credentials.
process.env.BLOG_SERP_BRIEF = 'off';

// Regression coverage for a real, recurring report: a single bounded expand
// pass reliably landed just under MIN_TOTAL_WORDS (a real run: 740/800) and
// generation was rejected outright even though a second pass — targeting
// the real, now-smaller shortfall — would plausibly have cleared it. The
// generator now allows up to MAX_EXPAND_ATTEMPTS bounded passes before
// giving up.
describe('blog-outline generator — multi-attempt expansion', () => {
  let site;

  before(async () => {
    const { rows } = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id)
       VALUES ('Blog Outline Expand Test Site', 'sc-domain:blog-outline-expand-test.example', 'test-ga4')
       RETURNING *`
    );
    site = rows[0];
  });

  after(async () => {
    await query('DELETE FROM sites WHERE id = $1', [site.id]);
    // pool.end() deferred to the LAST describe block in this file (real
    // Postgres test DB, module-level pool — closing it here would break
    // every describe block that runs after this one).
  });

  test('meta.id is stable (existing recommendations/drafts key on it)', () => {
    assert.equal(meta.id, 'blog-outline');
  });

  test('keeps expanding across more than one bounded attempt when the first expand pass still falls short, and succeeds once a later attempt clears the floor', async () => {
    const original = globalThis.fetch;
    let llmCalls = 0;
    const shortSection = (words) => ({ heading: 'Section', body: Array(words).fill('word').join(' ') });
    const four = (total) => Array.from({ length: 4 }, () => shortSection(Math.ceil(total / 4)));

    globalThis.fetch = async () => {
      llmCalls += 1;
      let sections;
      if (llmCalls === 1) {
        // Initial draft: well under the floor.
        sections = four(300);
      } else if (llmCalls === 2) {
        // First expand pass: still short (mirrors the real 740/800 report).
        sections = four(740);
      } else {
        // Second expand pass: clears MIN_TOTAL_WORDS.
        sections = four(852);
      }
      const text = llmCalls === 1
        ? JSON.stringify({ title: 'T', metaDescription: 'D', sections, suggestedFaqTopics: [], suggestedInternalLinks: [] })
        : JSON.stringify(sections);
      const body = { id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text }], model: 'claude-haiku-4-5', stop_reason: 'end_turn', usage: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const originalProvider = process.env.REPORT_PROVIDER;
    const originalKey = process.env.ANTHROPIC_API_KEY;
    const originalPexelsKey = process.env.PEXELS_API_KEY;
    const originalBlogImages = process.env.BLOG_IMAGES_ENABLED;
    process.env.REPORT_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // Disabled, not just left as-is: when a real PEXELS_API_KEY/
    // BLOG_IMAGES_ENABLED are set in the environment (as they are for real
    // dev use — see .env), generate()'s best-effort searchImage call makes
    // its own real (mock-intercepted) fetch AFTER the word-count assertion
    // below is meant to hold, which this shared globalThis.fetch mock can't
    // tell apart from an actual LLM call — silently inflating llmCalls and
    // making this test's pass/fail depend on ambient env instead of only on
    // generate()'s own expand-retry behavior.
    delete process.env.PEXELS_API_KEY;
    delete process.env.BLOG_IMAGES_ENABLED;

    try {
      const { content, summary } = await generate({ siteId: site.id, params: { topic: 'A test blog topic' } });
      // 1 initial call + 2 expand-pass calls (bounded at MAX_EXPAND_ATTEMPTS).
      assert.equal(llmCalls, 3);
      assert.ok(content.sections.slice(0, 4).reduce((n, s) => n + s.body.split(/\s+/).length, 0) >= 800);
      // +6 words over the mocked 850-word draft: the deterministic
      // Zunkireelabs agency-credit section (zunkireelabs-growth-policy.js's
      // agencyCreditLine) is appended as its own section on every site that
      // doesn't opt out — this test's fixture site has no client_number set
      // (so it isn't Zunkireelabs's own site 1) and no allow_agency_credit
      // override, so it gets the default-on credit line.
      assert.match(summary, /858 words/);
      assert.equal(content.sections.length, 5);
      assert.match(content.sections[4].body, /Zunkireelabs/);
    } finally {
      globalThis.fetch = original;
      if (originalProvider === undefined) delete process.env.REPORT_PROVIDER;
      else process.env.REPORT_PROVIDER = originalProvider;
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
      if (originalPexelsKey === undefined) delete process.env.PEXELS_API_KEY;
      else process.env.PEXELS_API_KEY = originalPexelsKey;
      if (originalBlogImages === undefined) delete process.env.BLOG_IMAGES_ENABLED;
      else process.env.BLOG_IMAGES_ENABLED = originalBlogImages;
    }
  });

  test('rejects outright when every bounded expand attempt still falls short', async () => {
    const original = globalThis.fetch;
    const shortSection = (words) => ({ heading: 'Section', body: Array(words).fill('word').join(' ') });

    globalThis.fetch = async () => {
      const body = {
        id: 'msg', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({ title: 'T', metaDescription: 'D', sections: [shortSection(100)], suggestedFaqTopics: [], suggestedInternalLinks: [] }) }],
        model: 'claude-haiku-4-5', stop_reason: 'end_turn', usage: {},
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const originalProvider = process.env.REPORT_PROVIDER;
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.REPORT_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'test-key';

    try {
      await assert.rejects(
        () => generate({ siteId: site.id, params: { topic: 'A test blog topic' } }),
        /produced only \d+ words after expansion/,
      );
    } finally {
      globalThis.fetch = original;
      if (originalProvider === undefined) delete process.env.REPORT_PROVIDER;
      else process.env.REPORT_PROVIDER = originalProvider;
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  // BLOG STANDARD: a post long enough but with fewer than 4 headed sections gets ONE split pass; a pass that returns less is never kept.
  async function runWithResponses(responses) {
    const original = globalThis.fetch;
    const saved = { p: process.env.REPORT_PROVIDER, k: process.env.ANTHROPIC_API_KEY, px: process.env.PEXELS_API_KEY, bi: process.env.BLOG_IMAGES_ENABLED };
    let calls = 0;
    globalThis.fetch = async () => {
      const r = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      const text = calls === 1 ? JSON.stringify({ title: 'T', metaDescription: 'D', sections: r, suggestedFaqTopics: [], suggestedInternalLinks: [] }) : JSON.stringify(r);
      const body = { id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text }], model: 'claude-haiku-4-5', stop_reason: 'end_turn', usage: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    process.env.REPORT_PROVIDER = 'anthropic'; process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.PEXELS_API_KEY; delete process.env.BLOG_IMAGES_ENABLED;
    try {
      const out = await generate({ siteId: site.id, params: { topic: 'A test blog topic' } });
      return { ...out, calls };
    } finally {
      globalThis.fetch = original;
      for (const [k, v] of [['REPORT_PROVIDER', saved.p], ['ANTHROPIC_API_KEY', saved.k], ['PEXELS_API_KEY', saved.px], ['BLOG_IMAGES_ENABLED', saved.bi]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }
  const sec = (words, n = 1) => Array.from({ length: n }, (_, i) => ({ heading: `Part ${i + 1}`, body: Array(Math.ceil(words / n)).fill('word').join(' ') }));

  test('900 words in 2 sections: exactly one extra pass splits it into 4 headed sections', async () => {
    const { calls, content } = await runWithResponses([sec(900, 2), sec(900, 4)]);
    assert.equal(calls, 2);
    assert.equal(content.sections.filter((s) => s.heading.startsWith('Part')).length, 4);
  });

  test('a split pass that comes back shorter than the draft is discarded, the post keeps its original sections', async () => {
    const { calls, content } = await runWithResponses([sec(900, 2), sec(300, 4)]);
    assert.equal(calls, 2);
    assert.equal(content.sections.filter((s) => s.heading.startsWith('Part')).length, 2);
  });

  test('a post already at 4+ sections and over the floor makes no extra model call', async () => {
    const { calls } = await runWithResponses([sec(900, 4)]);
    assert.equal(calls, 1);
  });
});

// Regression coverage for the 2026-09-15 "locally-generated posts should be
// able to carry real categories, never an invented one" change.
describe('blog-outline generator — real-category validation', () => {
  let site;

  before(async () => {
    const { rows } = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id, url_file_map)
       VALUES ('Blog Outline Categories Test Site', 'sc-domain:blog-outline-categories-test.example', 'test-ga4', $1)
       RETURNING *`,
      [JSON.stringify({ newContentTargets: { 'blog-outline': { categoriesSource: { projectId: 'test-project', dataset: 'production' } } } })],
    );
    site = rows[0];
  });

  after(async () => {
    await query('DELETE FROM sites WHERE id = $1', [site.id]);
    // pool.end() deferred to the LAST describe block in this file.
  });

  function longEnoughSections() {
    return [{ heading: 'Section', body: Array(850).fill('word').join(' ') }];
  }

  async function runWithMocks({ categoriesResult, llmCategories, llmExtra = {} }) {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('apicdn.sanity.io')) {
        return new Response(JSON.stringify({ result: categoriesResult }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const text = JSON.stringify({
        title: 'T', metaDescription: 'D', sections: longEnoughSections(),
        suggestedFaqTopics: [], suggestedInternalLinks: [], categories: llmCategories, ...llmExtra,
      });
      const body = { id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text }], model: 'claude-haiku-4-5', stop_reason: 'end_turn', usage: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const originalProvider = process.env.REPORT_PROVIDER;
    const originalKey = process.env.ANTHROPIC_API_KEY;
    const originalPexelsKey = process.env.PEXELS_API_KEY;
    const originalBlogImages = process.env.BLOG_IMAGES_ENABLED;
    process.env.REPORT_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.PEXELS_API_KEY;
    delete process.env.BLOG_IMAGES_ENABLED;
    try {
      return await generate({ siteId: site.id, params: { topic: 'A test blog topic' } });
    } finally {
      globalThis.fetch = original;
      if (originalProvider === undefined) delete process.env.REPORT_PROVIDER;
      else process.env.REPORT_PROVIDER = originalProvider;
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
      if (originalPexelsKey === undefined) delete process.env.PEXELS_API_KEY;
      else process.env.PEXELS_API_KEY = originalPexelsKey;
      if (originalBlogImages === undefined) delete process.env.BLOG_IMAGES_ENABLED;
      else process.env.BLOG_IMAGES_ENABLED = originalBlogImages;
    }
  }

  test('a category the model picks from the real list is kept, with its real slug', async () => {
    const { content } = await runWithMocks({
      categoriesResult: [{ title: 'Study Abroad', slug: 'study-abroad' }, { title: 'Visas', slug: 'visas' }],
      llmCategories: ['Study Abroad'],
    });
    assert.deepEqual(content.categories, [{ slug: 'study-abroad', title: 'Study Abroad' }]);
  });

  test('an invented category the model returns (not in the real list) is dropped, never fabricated', async () => {
    const { content } = await runWithMocks({
      categoriesResult: [{ title: 'Study Abroad', slug: 'study-abroad' }],
      llmCategories: ['Study Abroad', 'Made Up Category That Does Not Exist'],
    });
    assert.deepEqual(content.categories, [{ slug: 'study-abroad', title: 'Study Abroad' }]);
  });

  const faq = (n) => Array.from({ length: n }, (_, i) => ({ question: `What does part ${i} of the guide cover?`, answer: 'It explains the step in plain words, using only what the guide already says about it.' }));

  test('quickAnswer and faqItems the model writes from the post are kept when grounded (no invented figures, no links)', async () => {
    const { content } = await runWithMocks({
      categoriesResult: [], llmCategories: [],
      llmExtra: { quickAnswer: 'The guide explains each step in plain words, using only what the post itself already says.', faqItems: faq(3) },
    });
    assert.match(content.quickAnswer, /^The guide explains each step/);
    assert.equal(content.faqItems.length, 3);
    assert.equal(content.sources, undefined, 'sources are never generated');
  });

  test('an invented figure or a link drops the field instead of shipping it; fewer than three FAQ items yields none', async () => {
    const { content } = await runWithMocks({
      categoriesResult: [], llmCategories: [],
      llmExtra: { quickAnswer: 'The fee is £999 for everyone according to the guide, which the post never states.', faqItems: faq(2) },
    });
    assert.equal(content.quickAnswer, undefined);
    assert.equal(content.faqItems, undefined);
    const linky = await runWithMocks({ categoriesResult: [], llmCategories: [], llmExtra: { faqItems: [...faq(3).slice(0, 2), { question: 'Where do I read more?', answer: 'Read more at https://example.com/guide for everything the guide says about it.' }] } });
    assert.equal(linky.content.faqItems, undefined);
  });

  test('more than 3 real categories picked is capped at 3', async () => {
    const categoriesResult = [1, 2, 3, 4].map((n) => ({ title: `Cat ${n}`, slug: `cat-${n}` }));
    const { content } = await runWithMocks({
      categoriesResult,
      llmCategories: categoriesResult.map((c) => c.title),
    });
    assert.equal(content.categories.length, 3);
  });

  test('no categoriesSource configured -> no category fetch, empty categories, never blocks generation', async () => {
    const original = globalThis.fetch;
    let sanityFetchCalled = false;
    globalThis.fetch = async (url) => {
      if (String(url).includes('apicdn.sanity.io')) sanityFetchCalled = true;
      const text = JSON.stringify({ title: 'T', metaDescription: 'D', sections: longEnoughSections(), suggestedFaqTopics: [], suggestedInternalLinks: [] });
      const body = { id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text }], model: 'claude-haiku-4-5', stop_reason: 'end_turn', usage: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    process.env.REPORT_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const { rows } = await query(
        `INSERT INTO sites (name, gsc_property, ga4_property_id) VALUES ('No Categories Site', 'sc-domain:no-categories-test.example', 'test-ga4') RETURNING *`,
      );
      try {
        const { content } = await generate({ siteId: rows[0].id, params: { topic: 'A test blog topic' } });
        assert.equal(sanityFetchCalled, false);
        assert.deepEqual(content.categories, []);
      } finally {
        await query('DELETE FROM sites WHERE id = $1', [rows[0].id]);
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});

// Regression coverage for the 2026-09-15 "body may use light Markdown, but
// an inline link must still only ever point at a real candidate URL, same
// as suggestedInternalLinks" change.
describe('blog-outline generator — inline-link sanitization', () => {
  let site;

  before(async () => {
    const { rows } = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id) VALUES ('Blog Outline Inline Links Test Site', 'sc-domain:blog-outline-inline-links-test.example', 'test-ga4') RETURNING *`,
    );
    site = rows[0];
  });

  after(async () => {
    await query('DELETE FROM sites WHERE id = $1', [site.id]);
    await pool.end();
  });

  test('an inline Markdown link to a URL that is not a real candidate is stripped to plain text', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      const body = 'Read our [pricing guide](https://example.com/totally-invented-page) for more details. '
        + Array(800).fill('word').join(' ');
      const text = JSON.stringify({
        title: 'T', metaDescription: 'D', sections: [{ heading: 'Section', body }],
        suggestedFaqTopics: [], suggestedInternalLinks: [],
      });
      const resBody = { id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text }], model: 'claude-haiku-4-5', stop_reason: 'end_turn', usage: {} };
      return new Response(JSON.stringify(resBody), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    process.env.REPORT_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.PEXELS_API_KEY;
    delete process.env.BLOG_IMAGES_ENABLED;
    try {
      const { content } = await generate({ siteId: site.id, params: { topic: 'A test blog topic' } });
      assert.doesNotMatch(content.sections[0].body, /\[pricing guide\]\(/);
      assert.match(content.sections[0].body, /Read our pricing guide for more details/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('blog standard: internal links to real pages', () => {
  const cand = new Set(['https://x.test/a', 'https://x.test/b', 'https://x.test/c']);
  const sec = (body) => [{ heading: 'H', body }];
  test('internalLinkCount counts different real pages only; an invented URL and repeats do not count', () => {
    const s = sec('See [a](https://x.test/a), again [a2](https://x.test/a), [b](https://x.test/b) and [z](https://x.test/zzz).');
    assert.equal(internalLinkCount(s, cand), 2);
  });
  test('keepIfMoreLinks keeps a pass that added real links without shortening the post', () => {
    const before = sec('one two three four');
    const after = sec('one two three four [a](https://x.test/a) five');
    const kept = keepIfMoreLinks(before, after, cand);
    assert.notEqual(kept, before);
    assert.equal(internalLinkCount(kept, cand), 1);
  });
  test('keepIfMoreLinks drops a pass that shortened the post, added no links, or linked an invented URL', () => {
    const before = sec('one two three four five six');
    assert.equal(keepIfMoreLinks(before, sec('one two [a](https://x.test/a)'), cand), before);
    assert.equal(keepIfMoreLinks(before, sec('one two three four five six'), cand), before);
    assert.equal(keepIfMoreLinks(before, sec('one two three four five six [z](https://x.test/zzz)'), cand), before);
    assert.equal(keepIfMoreLinks(before, null, cand), before);
  });
});
