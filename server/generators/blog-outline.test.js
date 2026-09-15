import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './blog-outline.js';
import { query, pool } from '../db.js';

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

    globalThis.fetch = async () => {
      llmCalls += 1;
      let sections;
      if (llmCalls === 1) {
        // Initial draft: well under the floor.
        sections = [shortSection(300)];
      } else if (llmCalls === 2) {
        // First expand pass: still short (mirrors the real 740/800 report).
        sections = [shortSection(740)];
      } else {
        // Second expand pass: clears MIN_TOTAL_WORDS.
        sections = [shortSection(850)];
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
      assert.ok(content.sections[0].body.split(/\s+/).length >= 800);
      assert.match(summary, /850 words/);
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

  async function runWithMocks({ categoriesResult, llmCategories }) {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('apicdn.sanity.io')) {
        return new Response(JSON.stringify({ result: categoriesResult }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const text = JSON.stringify({
        title: 'T', metaDescription: 'D', sections: longEnoughSections(),
        suggestedFaqTopics: [], suggestedInternalLinks: [], categories: llmCategories,
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
