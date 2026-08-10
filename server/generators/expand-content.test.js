import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './expand-content.js';

// Only exercises the input-validation path, which throws before ever
// fetching the live page or calling the LLM — no real network needed.
describe('expand-content generator', () => {
  test('requires page', async () => {
    await assert.rejects(() => generate({ params: {} }));
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'expand-content');
  });
});

// Same extraction-fallback regression coverage as qa-content.test.js/
// schema.test.js — a successful fetch with only nav/footer boilerplate must
// refuse to draft rather than expand content grounded in that boilerplate.
// Guard runs and throws before generate() ever reaches the LLM.
describe('expand-content generator — thin-extraction guard', () => {
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
