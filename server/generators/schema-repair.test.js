import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './schema-repair.js';

// Only exercises the input-validation path, which throws before ever
// fetching the live page or calling the LLM — no real network needed.
describe('schema-repair generator', () => {
  test('requires page', async () => {
    await assert.rejects(() => generate({ params: {} }));
  });

  test('meta.id matches the generatorId page-content.js wires into GAP_TYPE_TO_GENERATOR', () => {
    assert.equal(meta.id, 'schema-repair');
  });
});

function stubFetchHtml(html) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => html,
    url,
  });
  return () => { globalThis.fetch = original; };
}

describe('schema-repair generator — remove-duplicate (no LLM call, deterministic)', () => {
  test('picks the second occurrence of the duplicated type as the removal candidate', async () => {
    const restore = stubFetchHtml(
      '<html><head><title>T</title>'
      + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"First"}</script>'
      + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Second"}</script>'
      + '</head><body><p>Real page content, long enough to pass grounding checks if any applied here.</p></body></html>',
    );
    try {
      const { content, summary } = await generate({ siteId: 1, params: { page: 'https://example.com/dup' } });
      assert.equal(content.fixType, 'remove-duplicate');
      assert.equal(content.duplicateType, 'Article');
      assert.match(content.originalRaw, /"headline":"Second"/);
      assert.match(summary, /duplicate/i);
    } finally { restore(); }
  });
});

describe('schema-repair generator — nothing to fix', () => {
  test('refuses when the page has neither malformed nor duplicate schema', async () => {
    const restore = stubFetchHtml('<html><head><title>T</title></head><body><p>Clean page.</p></body></html>');
    try {
      await assert.rejects(
        () => generate({ siteId: 1, params: { page: 'https://example.com/clean' } }),
        /no malformed or duplicate structured data/i,
      );
    } finally { restore(); }
  });
});
