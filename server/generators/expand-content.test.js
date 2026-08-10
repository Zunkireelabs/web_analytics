import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './expand-content.js';
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
// generic "try again shortly" error. Uses a real, throwaway site row (this
// repo's own real-DB convention — see strategy-registry.test.js) since
// hasAuthorProfile() reads real site columns, not a mock.
describe('expand-content generator — author-byline with no configured author profile', () => {
  let site;

  before(async () => {
    const { rows } = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id)
       VALUES ('expand-content-author-byline-test-site', 'sc-domain:expand-content-author-test.example', 'test-ga4')
       RETURNING *`
    );
    site = rows[0];
  });

  after(async () => {
    await query('DELETE FROM sites WHERE id = $1', [site.id]);
    await pool.end();
  });

  test('drafts a deterministic placeholder that passes the Quality Gate, without calling the LLM', async () => {
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
      assert.match(content.sections[0].body, /NEEDS INPUT/);
      const gate = runQualityGate(content, meta.id);
      assert.deepEqual(gate.issues, []);
      assert.equal(gate.clean, true);
    } finally { globalThis.fetch = original; }
  });
});
