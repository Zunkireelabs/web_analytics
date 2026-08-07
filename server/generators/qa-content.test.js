import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './qa-content.js';

// Only exercises the input-validation path, which throws before ever
// fetching the live page or calling the LLM — no real network needed.
describe('qa-content generator', () => {
  test('requires page', async () => {
    await assert.rejects(() => generate({ params: {} }));
  });

  test('meta.id matches the generatorId geo-signals.js wires into recommendedAction', () => {
    assert.equal(meta.id, 'qa-content');
  });
});

// Regression coverage for the extraction-fallback bug class: a fetch can
// succeed (real 200, real HTML) while the real content extraction still
// comes up thin/empty (nav+footer only) — this must refuse to draft rather
// than ground Q&A content in boilerplate. Stubs global fetch (the only
// thing page-content.js's fetchHtml calls) so requireGroundedContent's
// throw — which happens before generate() ever reaches the LLM — can be
// exercised without a real network call or LLM API key.
describe('qa-content generator — thin-extraction guard', () => {
  test('refuses to draft when the page has only nav/footer boilerplate', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => ({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html><head><title>T</title></head><body>'
        + '<nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>'
        + '<footer>Copyright 2026 Example Co. All rights reserved.</footer>'
        + '</body></html>',
      url,
    });
    try {
      await assert.rejects(
        () => generate({ siteId: 1, params: { page: 'https://example.com/thin' } }),
        /not enough real page content/i,
      );
    } finally { globalThis.fetch = original; }
  });
});
