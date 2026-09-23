import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta, sanitizeTable, mergeCitationSections } from './expand-content.js';
import { runQualityGate } from './lib/quality-gate.js';
import { _resetQuotaForTests } from '../ingest/search-grounding-providers/tavily.js';

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

// SYSTEM_COMPARISON's optional structured "table" field — the shape a real
// production draft (site 1, /locations/bhaktapur/) invented unprompted
// before the schema described it explicitly, and the ONLY of the three
// shapes the model has produced for this (the others: GFM markdown, raw
// HTML) that marker-merge.js's renderComparisonTable can safely render with
// the site's own styling rather than trusting model-authored markup.
describe('expand-content generator — sanitizeTable', () => {
  test('keeps a well-formed table unchanged', () => {
    const table = [
      { feature: 'Custom AI Solutions', competitor: 'No', zunkiree_labs: 'Yes' },
      { feature: 'Local Market Specialization', competitor: 'Limited', zunkiree_labs: 'Yes' },
    ];
    assert.deepEqual(sanitizeTable(table), table);
  });

  test('drops a single-row "table" — not really a comparison', () => {
    assert.equal(sanitizeTable([{ feature: 'Only one thing' }]), undefined);
  });

  test('drops non-array, empty array, and non-object rows', () => {
    assert.equal(sanitizeTable(undefined), undefined);
    assert.equal(sanitizeTable(null), undefined);
    assert.equal(sanitizeTable('not an array'), undefined);
    assert.equal(sanitizeTable([]), undefined);
  });

  test('every row is forced onto the FIRST row\'s column set, in the same order', () => {
    const table = [
      { feature: 'A', us: 'Yes' },
      { feature: 'B', us: 'No', extraKeyIgnored: 'x' },
    ];
    const result = sanitizeTable(table);
    assert.deepEqual(Object.keys(result[0]), ['feature', 'us']);
    assert.deepEqual(Object.keys(result[1]), ['feature', 'us']);
  });

  test('drops the whole table if any row is missing a required column or has a non-string/number value', () => {
    const table = [
      { feature: 'A', us: 'Yes' },
      { feature: 'B' }, // missing "us"
    ];
    assert.equal(sanitizeTable(table), undefined);
  });

  test('caps rows, columns, and cell length rather than shipping something pathological', () => {
    const bigRow = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`col${i}`, 'x']));
    const table = Array.from({ length: 30 }, () => bigRow);
    const result = sanitizeTable(table);
    assert.ok(result.length <= 12, 'rows must be capped');
    assert.ok(Object.keys(result[0]).length <= 6, 'columns must be capped');

    const longCell = [{ a: 'x'.repeat(500), b: 'y' }, { a: 'z', b: 'w' }];
    const capped = sanitizeTable(longCell);
    assert.ok(capped[0].a.length <= 200, 'a single cell must be capped');
  });

  test('coerces a numeric cell value to a string rather than rejecting it', () => {
    const table = [{ feature: 'Price', us: 42 }, { feature: 'Speed', us: 10 }];
    const result = sanitizeTable(table);
    assert.equal(result[0].us, '42');
  });
});

// Regression for the 2026-09-17 zunkireelabs /about/ incident: the model
// returned one section PER citation, each independently titled "References",
// and marker-merge rendered every one as its own visible <h2> — three
// duplicate "References" headings stacked down the live page.
describe('expand-content generator — mergeCitationSections', () => {
  test('a single section is returned unchanged', () => {
    const sections = [{ heading: 'References', body: '- [A](https://a.example)' }];
    assert.deepEqual(mergeCitationSections(sections), sections);
  });

  test('multiple per-source sections collapse into exactly one, bodies concatenated', () => {
    const sections = [
      { heading: 'References', body: '- [A](https://a.example)' },
      { heading: 'References', body: '- [B](https://b.example)' },
      { heading: 'References', body: '- [C](https://c.example)' },
    ];
    const result = mergeCitationSections(sections);
    assert.equal(result.length, 1);
    assert.equal(result[0].heading, 'References');
    assert.match(result[0].body, /a\.example/);
    assert.match(result[0].body, /b\.example/);
    assert.match(result[0].body, /c\.example/);
  });

  test('an empty array is returned unchanged', () => {
    assert.deepEqual(mergeCitationSections([]), []);
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

// Retired platform-wide (2026-09-24, explicit owner decision): a visible
// "About the Author" section is never drafted for any site anymore, whether
// from a real configured individual author or the organization-name
// fallback. Previously the organization fallback bypassed
// require_visible_byline entirely, so a site whose own policy said "no
// visible byline" (the column's default) still got an unwanted section on
// every run — this replaces both paths (and the earlier
// organization-byline auto-fill covered by this describe block) with a
// single, unconditional, honest refusal. No DB site row needed: this no
// longer reads any site column at all.
describe('expand-content generator — author-byline is retired', () => {
  test('refuses honestly, no LLM call, regardless of site or its author configuration', async () => {
    const original = globalThis.fetch;
    let fetchWasCalled = false;
    globalThis.fetch = async () => { fetchWasCalled = true; throw new Error('should never be called'); };
    try {
      await assert.rejects(
        () => generate({ siteId: 1, params: { page: 'https://example.com/real-page', focus: 'author-byline' } }),
        /retired platform-wide/i,
      );
      assert.equal(fetchWasCalled, false, 'refuses before ever fetching the page or configuring an author');
    } finally { globalThis.fetch = original; }
  });
});

// RETIRED 2026-09-20. This focus used to draft a deterministic VISIBLE
// "Last Updated" section — see expand-content.js's own comment on the
// 'freshness-date' branch for why: it shipped as an unclassed, unstyled
// <h1> live on site 8864 (chayceproperties.com). It now refuses outright
// instead, for every caller, so a visible "Last Updated" block can never
// ship from this generator again — the same freshness fact belongs in
// schema.js's datePublished/dateModified JSON-LD instead.
describe('expand-content generator — freshness-date (retired)', () => {
  test('refuses outright — never drafts a visible "Last Updated" section', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => ({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html><head><title>Real Page</title></head><body><main><p>'
        + 'Real, substantial page body content about a product. '.repeat(10)
        + '</p></main></body></html>',
      url,
    });
    try {
      await assert.rejects(
        () => generate({ siteId: 1, params: { page: 'https://example.com/real-page', focus: 'freshness-date' } }),
        /retired/i,
      );
    } finally { globalThis.fetch = original; }
  });
});
