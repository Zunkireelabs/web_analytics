import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './open-graph.js';

// Only exercises the input-validation path, which throws before ever
// fetching the live page — no real network needed. The real-content-
// grounding path is covered by manual/sandbox verification.
describe('open-graph generator', () => {
  test('requires page', async () => {
    await assert.rejects(() => generate({ params: {} }));
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'open-graph');
  });
});

// open-graph is a pure/deterministic generator (no LLM call at all), so its
// full output can be asserted directly — including the extraction-fallback
// regression case: a page with no real <meta name="description"> and only
// nav/footer boilerplate as "body text" must fall through to the
// placeholder, not ship that boilerplate as a live og:description.
describe('open-graph generator — thin-extraction guard', () => {
  test('falls back to the placeholder instead of using nav/footer boilerplate as og:description', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => ({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html><head><title>Real Title</title></head><body>'
        + '<nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>'
        + '<footer>Copyright 2026 Example Co. All rights reserved.</footer>'
        + '</body></html>',
      url,
    });
    try {
      const { content } = await generate({ params: { page: 'https://example.com/thin' } });
      assert.equal(content.ogTitle, 'Real Title');
      assert.equal(content.ogDescription, '[NEEDS INPUT — not verifiable from real site data]');
      assert.deepEqual(content.placeholderFields, ['ogDescription']);
    } finally { globalThis.fetch = original; }
  });
});

// Twitter Card tags are a deterministic mirror of the same real og:title/
// og:description — no second grounding decision, no separate placeholder
// logic, so this just pins that they always agree with each other.
describe('open-graph generator — Twitter Card tags', () => {
  test('twitterTitle/twitterDescription mirror ogTitle/ogDescription exactly', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => ({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html><head><title>Real Title</title>'
        + '<meta name="description" content="A real meta description for this page.">'
        + '</head><body><p>content</p></body></html>',
      url,
    });
    try {
      const { content } = await generate({ params: { page: 'https://example.com/real' } });
      assert.equal(content.twitterCard, 'summary_large_image');
      assert.equal(content.twitterTitle, content.ogTitle);
      assert.equal(content.twitterDescription, content.ogDescription);
    } finally { globalThis.fetch = original; }
  });
});
