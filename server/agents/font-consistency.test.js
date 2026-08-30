import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// Same DATABASE_URL placeholder workaround as country-intelligence.test.js —
// this file's import chain reaches server/db.js at import time.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../llm.js'), { namedExports: { callLLM: async () => 'stubbed narrative' } });

const { run, meta } = await import('./font-consistency.js');

function h(tag, fontSize, outerHtml) {
  return { tag, fontSize, outerHtml, inlineStyle: null, classes: '', text: '' };
}

describe('font-consistency agent', () => {
  test('meta.id is font-consistency', () => {
    assert.equal(meta.id, 'font-consistency');
  });

  test('insufficient-data when the site has no configured domain', async () => {
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: null, gsc_property: null }),
      capture: async () => { throw new Error('should not be called'); },
    });
    assert.equal(result.status, 'insufficient-data');
  });

  test('error status when the live capture itself fails', async () => {
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => { throw new Error('browser launch failed'); },
    });
    assert.equal(result.status, 'error');
    assert.match(result.message, /browser launch failed/i);
  });

  test('ok, no findings when every page is consistent', async () => {
    const pages = [
      { url: 'https://example.com/a', headings: [h('h1', '32px', '<h1>A</h1>')], paragraphs: [] },
      { url: 'https://example.com/b', headings: [h('h1', '32px', '<h1>B</h1>')], paragraphs: [] },
      { url: 'https://example.com/c', headings: [h('h1', '32px', '<h1>C</h1>')], paragraphs: [] },
    ];
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => pages,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.facts.findings.length, 0);
  });

  test('flags an outlier and attaches a recommendedAction only when it has an inline override', async () => {
    const pages = [
      { url: 'https://example.com/a', headings: [h('h1', '32px', '<h1>A</h1>')], paragraphs: [] },
      { url: 'https://example.com/b', headings: [h('h1', '32px', '<h1>B</h1>')], paragraphs: [] },
      { url: 'https://example.com/c', headings: [h('h1', '18px', '<h1 style="font-size: 18px;">C</h1>')], paragraphs: [] },
    ];
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => pages,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.facts.findings.length, 1);
    const finding = result.facts.findings[0];
    assert.ok(finding.recommendedAction);
    assert.equal(finding.recommendedAction.generatorId, 'content-integrity-repair');
    assert.equal(finding.recommendedAction.params.fixType, 'font-size-override');
    assert.equal(finding.recommendedAction.params.page, 'https://example.com/c');
  });

  test('flags an outlier but attaches no recommendedAction when it has no inline override (a CSS-class difference)', async () => {
    const pages = [
      { url: 'https://example.com/a', headings: [h('h1', '32px', '<h1>A</h1>')], paragraphs: [] },
      { url: 'https://example.com/b', headings: [h('h1', '32px', '<h1>B</h1>')], paragraphs: [] },
      { url: 'https://example.com/c', headings: [h('h1', '18px', '<h1 class="hero-sm">C</h1>')], paragraphs: [] },
    ];
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => pages,
    });
    assert.equal(result.facts.findings.length, 1);
    assert.equal(result.facts.findings[0].recommendedAction, null);
  });
});
