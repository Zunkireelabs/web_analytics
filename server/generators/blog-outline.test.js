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
    await pool.end();
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
