import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// Same DATABASE_URL placeholder workaround as country-intelligence.test.js —
// this file's import chain reaches server/db.js at import time.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../llm.js'), { namedExports: { callLLM: async () => 'stubbed narrative' } });

const { run, meta } = await import('./font-consistency.js');

function h(tag, fontSize, outerHtml, classes = '', ancestorClass = null, rawFontSizeDeclaration = null) {
  return { tag, fontSize, outerHtml, inlineStyle: null, classes, text: '', ancestorClass, rawFontSizeDeclaration };
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

  test('a live capture failure propagates rather than being caught into a custom error object', async () => {
    // Deliberately not caught inside run() — see font-consistency.js's own
    // comment: runner.js's existing try/catch already routes any thrown
    // error through safeMessage before it reaches anything customer-facing,
    // so building a second, ad-hoc error string here would risk leaking the
    // raw exception message instead.
    await assert.rejects(
      () => run({
        siteId: 1,
        fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
        capture: async () => { throw new Error('browser launch failed'); },
      }),
      /browser launch failed/,
    );
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

  test('flags a CSS-class outlier and routes it through typography-drift when a real site convention is resolvable', async () => {
    const pages = [
      { url: 'https://example.com/a', headings: [h('h1', '32px', '<h1 class="text-h1">A</h1>', 'text-h1')], paragraphs: [] },
      { url: 'https://example.com/b', headings: [h('h1', '32px', '<h1 class="text-h1">B</h1>', 'text-h1')], paragraphs: [] },
      { url: 'https://example.com/c', headings: [h('h1', '18px', '<h1 class="hero-sm">C</h1>', 'hero-sm')], paragraphs: [] },
    ];
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => pages,
    });
    assert.equal(result.facts.findings.length, 1);
    const finding = result.facts.findings[0];
    assert.ok(finding.recommendedAction);
    assert.equal(finding.recommendedAction.generatorId, 'content-integrity-repair');
    assert.equal(finding.recommendedAction.params.fixType, 'typography-drift');
    assert.equal(finding.recommendedAction.params.siteConvention, 'text-h1');
    assert.equal(finding.recommendedAction.params.page, 'https://example.com/c');
  });

  test('flags an unclassed, page-uniquely-scoped outlier and routes it through typography-drift-scoped', async () => {
    // Chayce's real shape: bare <h1>, no class of its own, styled entirely
    // via ".hiw-hero h1" — a wrapper class no other sampled page reuses,
    // with a plain (non-fluid) declared value.
    const pages = [
      { url: 'https://example.com/a', headings: [h('h1', '48px', '<h1>A</h1>', '', 'page-hero', '48px')], paragraphs: [] },
      { url: 'https://example.com/b', headings: [h('h1', '48px', '<h1>B</h1>', '', 'page-hero', '48px')], paragraphs: [] },
      { url: 'https://example.com/c', headings: [h('h1', '48px', '<h1>C</h1>', '', 'page-hero', '48px')], paragraphs: [] },
      { url: 'https://example.com/how-it-works', headings: [h('h1', '74px', '<h1>D</h1>', '', 'hiw-hero', '74px')], paragraphs: [] },
    ];
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => pages,
    });
    assert.equal(result.facts.findings.length, 1);
    const finding = result.facts.findings[0];
    assert.ok(finding.recommendedAction);
    assert.equal(finding.recommendedAction.generatorId, 'content-integrity-repair');
    assert.equal(finding.recommendedAction.params.fixType, 'typography-drift-scoped');
    assert.equal(finding.recommendedAction.params.ancestorClass, 'hiw-hero');
    assert.equal(finding.recommendedAction.params.tag, 'h1');
    assert.equal(finding.recommendedAction.params.expectedFontSize, '48px');
    assert.equal(finding.recommendedAction.params.page, 'https://example.com/how-it-works');
    assert.equal(finding.reportOnly, null);
  });

  test('a page-uniquely-scoped outlier with a fluid declared value stays reportOnly with a specific, real reason', async () => {
    const pages = [
      { url: 'https://example.com/a', headings: [h('h1', '48px', '<h1>A</h1>', '', 'page-hero', '48px')], paragraphs: [] },
      { url: 'https://example.com/b', headings: [h('h1', '48px', '<h1>B</h1>', '', 'page-hero', '48px')], paragraphs: [] },
      { url: 'https://example.com/c', headings: [h('h1', '48px', '<h1>C</h1>', '', 'page-hero', '48px')], paragraphs: [] },
      { url: 'https://example.com/how-it-works', headings: [h('h1', '74px', '<h1>D</h1>', '', 'hiw-hero', 'clamp(40px,6vw,74px)')], paragraphs: [] },
    ];
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => pages,
    });
    assert.equal(result.facts.findings.length, 1);
    const finding = result.facts.findings[0];
    assert.equal(finding.recommendedAction, null);
    assert.equal(finding.reportOnly.kind, 'font-size-inconsistency');
    assert.match(finding.reportOnly.whyBlocked, /confirmed scoped to only this one page/);
    assert.match(finding.reportOnly.whyBlocked, /clamp\(40px,6vw,74px\)/);
  });

  test('flags an outlier but attaches no recommendedAction when its class already matches the resolved convention', async () => {
    const pages = [
      { url: 'https://example.com/a', headings: [h('h1', '32px', '<h1 class="text-h1">A</h1>', 'text-h1')], paragraphs: [] },
      { url: 'https://example.com/b', headings: [h('h1', '32px', '<h1 class="text-h1">B</h1>', 'text-h1')], paragraphs: [] },
      { url: 'https://example.com/c', headings: [h('h1', '18px', '<h1 class="text-h1">C</h1>', 'text-h1')], paragraphs: [] },
    ];
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => pages,
    });
    assert.equal(result.facts.findings.length, 1);
    assert.equal(result.facts.findings[0].recommendedAction, null);
  });

  test('a landing-style template with its own confirmed h1 size is not flagged against a different interior-page majority', async () => {
    const pages = [
      { url: 'https://example.com/', pageType: 'homepage', headings: [h('h1', '60px', '<h1>Home</h1>')], paragraphs: [] },
      { url: 'https://example.com/landing-a', pageType: 'landing', headings: [h('h1', '60px', '<h1>A</h1>')], paragraphs: [] },
      { url: 'https://example.com/landing-b', pageType: 'landing', headings: [h('h1', '60px', '<h1>B</h1>')], paragraphs: [] },
      { url: 'https://example.com/blog', pageType: 'blog-listing', headings: [h('h1', '48px', '<h1>Blog</h1>')], paragraphs: [] },
      { url: 'https://example.com/faq', pageType: 'faq', headings: [h('h1', '48px', '<h1>FAQ</h1>')], paragraphs: [] },
      { url: 'https://example.com/terms', pageType: 'legal', headings: [h('h1', '48px', '<h1>Terms</h1>')], paragraphs: [] },
    ];
    const result = await run({
      siteId: 1,
      fetchSite: async () => ({ id: 1, website_domain: 'example.com' }),
      capture: async () => pages,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.facts.findings.length, 0);
  });
});
