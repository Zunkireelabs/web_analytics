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

// Second half of the fabrication fix, and deliberately redundant with
// page-content.js's skip: an empty `originalRaw` is not merely a useless
// exact-match anchor, it is a prompt with NOTHING to repair. The model
// answered that by inventing schema wholesale, and findSchemaIssues cannot
// catch it — invented schema is structurally valid. Refuse before the model
// is ever called.
describe('schema-repair generator — an empty malformed block is never "repaired"', () => {
  test('refuses outright rather than asking a model to invent schema from nothing', async () => {
    const restore = stubFetchHtml(
      '<html><head><title>T</title>'
      // Two tags of the SAME type so the duplicate branch is what would
      // otherwise run; the empty one is what must be refused.
      + '<script type="application/ld+json"></script>'
      + '</head><body><p>Real page content, long enough to look like a normal page.</p></body></html>',
    );
    try {
      await assert.rejects(
        () => generate({ siteId: 1, params: { page: 'https://example.com/empty-schema' } }),
        (err) => {
          // Either refusal is correct — what must NEVER happen is a draft
          // containing invented schema.
          assert.match(err.message, /empty|no malformed or duplicate structured data/i);
          return true;
        },
      );
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
