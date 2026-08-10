import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLiteralClassNames, extractStylesheetHrefs, checkTemplateFreshness, proposeUpdatedTemplate,
  templateActionRequiresRow, resolveOrCreateComponentTemplate,
} from './design-drift.js';

describe('templateActionRequiresRow', () => {
  test('true for the repeating-row action types', () => {
    assert.equal(templateActionRequiresRow('faq'), true);
    assert.equal(templateActionRequiresRow('expand-content'), true);
    assert.equal(templateActionRequiresRow('internal-links'), true);
    assert.equal(templateActionRequiresRow('qa-content'), true);
  });

  test('false for content-wrapper (one {{BODY}} slot, no row)', () => {
    assert.equal(templateActionRequiresRow('content-wrapper'), false);
  });
});

describe('resolveOrCreateComponentTemplate', () => {
  const baseSite = { id: 1, name: 'Test Site', repo_owner: 'acme', repo_name: 'acme-web', design_agent_enabled: true, url_file_map: {} };

  test('returns the existing template immediately without touching the Design Agent', async () => {
    const site = { ...baseSite, url_file_map: { siteRoot: { componentTemplates: { contentWrapper: { wrapper: '<div>{{BODY}}</div>' } } } } };
    const createHandler = () => { throw new Error('should never be called — a template already exists'); };
    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', { createHandler });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'existing');
    assert.equal(result.template.wrapper, '<div>{{BODY}}</div>');
  });

  test('action type with no component-template concept short-circuits', async () => {
    const createHandler = () => { throw new Error('should never be called'); };
    const result = await resolveOrCreateComponentTemplate(baseSite, 'meta-title', { createHandler });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-concept');
  });

  test('site without design_agent_enabled cannot auto-create, and never calls the handler', async () => {
    const site = { ...baseSite, design_agent_enabled: false };
    const createHandler = () => { throw new Error('should never be called'); };
    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', { createHandler });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-available');
  });

  test('site with no repo configured cannot auto-create', async () => {
    const site = { ...baseSite, repo_owner: null, repo_name: null };
    const createHandler = () => { throw new Error('should never be called'); };
    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', { createHandler });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-available');
  });

  test('derives, validates, and auto-saves a new template with no manual confirm step', async () => {
    const site = { ...baseSite };
    const derived = { wrapper: '<div class="prose">{{BODY}}</div>' };
    const createHandler = () => async (job) => {
      assert.equal(job.site_id, site.id);
      assert.deepEqual(job.params.componentKeys, ['content-wrapper']);
      return { componentTemplates: { 'content-wrapper': derived } };
    };
    let saved = null;
    const saveConfig = async ({ siteId, urlFileMap }) => { saved = { siteId, urlFileMap }; return { id: siteId, url_file_map: urlFileMap }; };
    let audited = null;
    const recordAudit = async (req, event) => { audited = { req, event }; };

    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', { createHandler, saveConfig, recordAudit });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'design-agent');
    assert.equal(result.justCreated, true);
    assert.deepEqual(result.template, derived);
    assert.equal(saved.siteId, site.id);
    assert.deepEqual(saved.urlFileMap.siteRoot.componentTemplates.contentWrapper, derived);
    assert.equal(audited.event.action, 'tenant.component_template_auto_created');
    assert.equal(audited.req.userId, null, 'no human triggered this — system actor, not a staff user');
  });

  test('a derived template missing its required placeholder is rejected, not saved', async () => {
    const site = { ...baseSite };
    const createHandler = () => async () => ({ componentTemplates: { 'content-wrapper': { wrapper: '<div>no body slot here</div>' } } });
    const saveConfig = async () => { throw new Error('should never be called — invalid template must not be saved'); };
    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', { createHandler, saveConfig });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-placeholders');
  });

  test('a Design Agent failure is reported, never thrown, and nothing is saved', async () => {
    const site = { ...baseSite };
    const createHandler = () => async () => { throw new Error('OpenHands task failed: simulated infra error'); };
    const saveConfig = async () => { throw new Error('should never be called'); };
    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', { createHandler, saveConfig });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'design-agent-error');
  });

  test('the handler returning nothing for the requested action type is treated as not-derived, not a crash', async () => {
    const site = { ...baseSite };
    const createHandler = () => async () => ({ componentTemplates: {} });
    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', { createHandler });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-derived');
  });
});

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
