import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLiteralClassNames, extractStylesheetHrefs, checkTemplateFreshness, proposeUpdatedTemplate,
} from './design-drift.js';

describe('extractLiteralClassNames', () => {
  test('collects deduped class tokens from wrapper + row', () => {
    const template = {
      wrapper: '<section class="py-12 md:py-20">\n{{ROWS}}\n</section>',
      row: '<div class="mb-8 last:mb-0"><h3 class="text-xl md:text-2xl">{{HEADING}}</h3></div>',
    };
    const classes = extractLiteralClassNames(template);
    assert.deepEqual([...classes].sort(), ['last:mb-0', 'mb-8', 'md:py-20', 'md:text-2xl', 'py-12', 'text-xl'].sort());
  });

  test('never mistakes a placeholder token for a class', () => {
    const classes = extractLiteralClassNames({ wrapper: '<div class="{{SOMEDYNAMIC}}">{{ROWS}}</div>', row: '' });
    assert.deepEqual(classes, []);
  });

  test('empty template yields no classes', () => {
    assert.deepEqual(extractLiteralClassNames({}), []);
  });
});

describe('extractStylesheetHrefs', () => {
  test('finds a stylesheet link regardless of attribute order', () => {
    const html = '<head><link href="/assets/main.css" rel="stylesheet" crossorigin></head>';
    assert.deepEqual(extractStylesheetHrefs(html), ['/assets/main.css']);
  });

  test('ignores non-stylesheet links', () => {
    const html = '<link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/style.css">';
    assert.deepEqual(extractStylesheetHrefs(html), ['/style.css']);
  });

  test('no stylesheet links at all -> empty array', () => {
    assert.deepEqual(extractStylesheetHrefs('<html><body>plain</body></html>'), []);
  });
});

describe('checkTemplateFreshness', () => {
  const template = {
    wrapper: '<section class="py-12 md:py-20">\n{{ROWS}}\n</section>',
    row: '<h3 class="text-xl md:text-2xl font-normal">{{HEADING}}</h3>',
  };
  const html = '<html><head><link rel="stylesheet" href="/assets/main.css"></head><body></body></html>';

  test('not stale when every class resolves in the live CSS, including responsive variants', async () => {
    const css = '.py-12{padding-top:3rem}.text-xl{font-size:1.25rem}.font-normal{font-weight:400}' +
      '@media(min-width:768px){.md\\:py-20{padding-top:5rem}.md\\:text-2xl{font-size:1.5rem}}';
    const result = await checkTemplateFreshness({
      pageUrl: 'https://example.com/page/',
      templateEntry: template,
      fetchPage: async () => html,
      fetchStylesheet: async () => css,
    });
    assert.equal(result.ok, true);
    assert.equal(result.stale, false);
    assert.deepEqual(result.missingClasses, []);
  });

  test('stale when the live CSS no longer defines a class the template uses', async () => {
    // font-normal is missing entirely — simulates a redesign that dropped it.
    const css = '.py-12{padding-top:3rem}.text-xl{font-size:1.25rem}' +
      '@media(min-width:768px){.md\\:py-20{padding-top:5rem}.md\\:text-2xl{font-size:1.5rem}}';
    const result = await checkTemplateFreshness({
      pageUrl: 'https://example.com/page/',
      templateEntry: template,
      fetchPage: async () => html,
      fetchStylesheet: async () => css,
    });
    assert.equal(result.ok, true);
    assert.equal(result.stale, true);
    assert.deepEqual(result.missingClasses, ['font-normal']);
  });

  test('never flags a class name that only appears inside another selector as a substring', async () => {
    // '.text-xl-custom{...}' contains the substring '.text-xl' but is a
    // different, unrelated class — must not count as a match.
    const css = '.text-xl-custom{color:red}.md\\:py-20{padding-top:5rem}.font-normal{font-weight:400}';
    const result = await checkTemplateFreshness({
      pageUrl: 'https://example.com/page/',
      templateEntry: template,
      fetchPage: async () => html,
      fetchStylesheet: async () => css,
    });
    assert.equal(result.stale, true);
    assert.ok(result.missingClasses.includes('text-xl'));
  });

  test('honest infra failure (page unreachable) fails OPEN, not stale', async () => {
    const result = await checkTemplateFreshness({
      pageUrl: 'https://example.com/page/',
      templateEntry: template,
      fetchPage: async () => null,
      fetchStylesheet: async () => 'irrelevant',
    });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });

  test('no class="..." anywhere in the template -> trivially not stale, no network calls made', async () => {
    let called = false;
    const result = await checkTemplateFreshness({
      pageUrl: 'https://example.com/page/',
      templateEntry: { wrapper: '{{ROWS}}', row: '{{HEADING}} {{BODY}}' },
      fetchPage: async () => { called = true; return html; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.stale, false);
    assert.equal(called, false);
  });
});

describe('proposeUpdatedTemplate', () => {
  test('grounds the proposal in the real fetched page and validates required placeholders', async () => {
    const result = await proposeUpdatedTemplate({
      pageUrl: 'https://example.com/page/',
      actionType: 'faq',
      oldTemplate: { wrapper: '<section>{{ROWS}}</section>', row: '<p>{{QUESTION}} {{ANSWER}}</p>' },
      missingClasses: ['font-normal'],
      fetchPage: async () => '<html><body class="new-design"></body></html>',
      callLLMFn: async () => JSON.stringify({
        wrapper: '<section class="new-design">{{ROWS}}</section>',
        row: '<p class="new-design">{{QUESTION}} {{ANSWER}}</p>',
      }),
    });
    assert.equal(result.ok, true);
    assert.match(result.template.wrapper, /new-design/);
  });

  test('rejects a proposal missing a required placeholder rather than saving a broken template', async () => {
    const result = await proposeUpdatedTemplate({
      pageUrl: 'https://example.com/page/',
      actionType: 'faq',
      oldTemplate: { wrapper: '<section>{{ROWS}}</section>', row: '<p>{{QUESTION}} {{ANSWER}}</p>' },
      fetchPage: async () => '<html></html>',
      callLLMFn: async () => JSON.stringify({ wrapper: '<section>{{ROWS}}</section>', row: '<p>{{QUESTION}}</p>' }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /ANSWER/);
  });

  test('honest failure when the page cannot be fetched at all', async () => {
    const result = await proposeUpdatedTemplate({
      pageUrl: 'https://example.com/page/',
      actionType: 'faq',
      oldTemplate: {},
      fetchPage: async () => null,
    });
    assert.equal(result.ok, false);
  });
});
