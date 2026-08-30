import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta, sanitizeTable } from './expand-content.js';
import { runQualityGate } from './lib/quality-gate.js';
import { query, pool } from '../db.js';

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

// Real incident (2026-08-10): a site with no configured author profile
// (sites.author_name unset — most clients, by default) hit this focus, the
// old code asked the LLM to write "By [Author Name], [Role]", and
// content-scaffolding-guard.js's author-placeholder pattern (deliberately
// built to reject exactly that bracket text) rejected it on every single
// attempt — a permanent, deterministic failure surfaced to the user as a
// generic "try again shortly" error. Fixed by auto-filling an Organization-
// level byline from the site's own real name (organizationByline) instead
// of an LLM-invented placeholder — fully automatic, zero manual step, never
// a fabricated person. Uses a real, throwaway site row (this repo's own
// real-DB convention — see strategy-registry.test.js) since
// hasAuthorProfile()/organizationByline() read real site columns, not a mock.
describe('expand-content generator — author-byline with no configured author profile', () => {
  let site;

  before(async () => {
    const { rows } = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id)
       VALUES ('Expand Content Author Byline Test Site', 'sc-domain:expand-content-author-test.example', 'test-ga4')
       RETURNING *`
    );
    site = rows[0];
  });

  after(async () => {
    await query('DELETE FROM sites WHERE id = $1', [site.id]);
    await pool.end();
  });

  test('auto-fills an Organization byline from the site\'s real name and passes the Quality Gate, without calling the LLM', async () => {
    const original = globalThis.fetch;
    let llmWasCalled = false;
    globalThis.fetch = async (url) => {
      if (String(url).includes('anthropic') || String(url).includes('openai')) llmWasCalled = true;
      return {
        ok: true,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<html><head><title>Real Page</title></head><body><main><p>'
          + 'Real, substantial page body content about a product. '.repeat(10)
          + '</p></main></body></html>',
        url,
      };
    };
    try {
      const { content } = await generate({ siteId: site.id, params: { page: 'https://example.com/real-page', focus: 'author-byline' } });
      assert.equal(llmWasCalled, false);
      assert.equal(content.sections[0].body, 'By the Expand Content Author Byline Test Site Team');
      const gate = await runQualityGate(content, meta.id);
      assert.deepEqual(gate.issues, []);
      assert.equal(gate.clean, true);
    } finally { globalThis.fetch = original; }
  });
});

// Real incident (2026-08-10): the old freshness-date prompt told the LLM to
// write a placeholder date, which content-scaffolding-guard.js's
// placeholder-bracket pattern then rejected on every attempt — a guaranteed
// failure, same bug class as the author-byline case above. Fixed by making
// freshness-date deterministic (today's real date, no LLM call) instead.
describe('expand-content generator — freshness-date', () => {
  test('drafts a deterministic Last Updated section with today\'s real date, without calling the LLM, and passes the Quality Gate', async () => {
    const original = globalThis.fetch;
    let llmWasCalled = false;
    globalThis.fetch = async (url) => {
      if (String(url).includes('anthropic') || String(url).includes('openai')) llmWasCalled = true;
      return {
        ok: true,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<html><head><title>Real Page</title></head><body><main><p>'
          + 'Real, substantial page body content about a product. '.repeat(10)
          + '</p></main></body></html>',
        url,
      };
    };
    try {
      const { content } = await generate({ siteId: 1, params: { page: 'https://example.com/real-page', focus: 'freshness-date' } });
      assert.equal(llmWasCalled, false);
      const today = new Date().toISOString().slice(0, 10);
      assert.match(content.sections[0].body, new RegExp(today));
      const gate = await runQualityGate(content, meta.id);
      assert.deepEqual(gate.issues, []);
      assert.equal(gate.clean, true);
    } finally { globalThis.fetch = original; }
  });
});
