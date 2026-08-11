import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLiteralClassNames, extractStylesheetHrefs, checkTemplateFreshness, proposeUpdatedTemplate,
  templateActionRequiresRow, resolveOrCreateComponentTemplate,
  isTemplateVerified, stampTemplateVerification, componentTemplateVerification,
  componentTemplateActionTypeFor, TEMPLATE_VERIFIED_BY,
} from './design-drift.js';

const VALID_FAQ = { wrapper: '<div class="faq">{{ROWS}}</div>', row: '<dt>{{QUESTION}}</dt><dd>{{ANSWER}}</dd>' };

describe('stampTemplateVerification', () => {
  test('attaches provenance without mutating the original', () => {
    const stamped = stampTemplateVerification(VALID_FAQ, { verifiedBy: TEMPLATE_VERIFIED_BY.HUMAN, verifiedRef: 42 });
    assert.equal(VALID_FAQ.verifiedAt, undefined, 'must not mutate the caller\'s object');
    assert.equal(stamped.verifiedBy, 'human');
    assert.equal(stamped.verifiedRef, '42', 'ref is normalised to a string so a user id and a job id read the same');
    assert.ok(Date.parse(stamped.verifiedAt), 'verifiedAt is a parseable ISO timestamp');
    assert.equal(stamped.wrapper, VALID_FAQ.wrapper, 'the template itself is carried through untouched');
  });
});

describe('isTemplateVerified', () => {
  test('an unstamped template is unverified — the correct reading of every pre-provenance template', () => {
    const v = isTemplateVerified('faq', VALID_FAQ);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'unverified');
  });

  test('a missing template is reported as missing, not merely unverified', () => {
    assert.equal(isTemplateVerified('faq', undefined).reason, 'missing');
    assert.equal(isTemplateVerified('faq', { row: '<dd>{{ANSWER}}</dd>' }).reason, 'missing', 'no wrapper means nothing to render');
  });

  test('a stamped template that satisfies its placeholder contract passes', () => {
    const stamped = stampTemplateVerification(VALID_FAQ, { verifiedBy: TEMPLATE_VERIFIED_BY.DESIGN_AGENT });
    const v = isTemplateVerified('faq', stamped);
    assert.equal(v.ok, true);
    assert.equal(v.verifiedBy, 'design-agent');
  });

  test('a stamp cannot launder a structurally broken template', () => {
    const stamped = stampTemplateVerification({ wrapper: '<div>{{ROWS}}</div>', row: '<dd>{{ANSWER}}</dd>' }, { verifiedBy: TEMPLATE_VERIFIED_BY.HUMAN });
    const v = isTemplateVerified('faq', stamped);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'invalid-placeholders', 'missing {{QUESTION}} still fails even though it is stamped');
  });

  test('makes no network call — safe on the hot path in generateDraft and the per-finding loop', () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('isTemplateVerified must never fetch'); };
    try {
      assert.equal(isTemplateVerified('faq', stampTemplateVerification(VALID_FAQ, { verifiedBy: 'human' })).ok, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('componentTemplateActionTypeFor', () => {
  test('the three compliance generators all share the generic content-wrapper key', () => {
    assert.equal(componentTemplateActionTypeFor('cookie-policy'), 'content-wrapper');
    assert.equal(componentTemplateActionTypeFor('privacy-policy'), 'content-wrapper');
    assert.equal(componentTemplateActionTypeFor('terms-of-service'), 'content-wrapper');
  });

  test('every other generator maps to itself', () => {
    assert.equal(componentTemplateActionTypeFor('faq'), 'faq');
    assert.equal(componentTemplateActionTypeFor('meta-title'), 'meta-title');
  });
});

describe('componentTemplateVerification', () => {
  test('action types with no component-template concept are never blocked', () => {
    // meta-title/schema/canonical/sitemap are plain values with no CSS
    // component that can drift — the gate must be invisible to them.
    for (const generatorId of ['meta-title', 'schema', 'canonical', 'sitemap', 'robots-fix']) {
      const v = componentTemplateVerification({ url_file_map: {} }, generatorId);
      assert.equal(v.ok, true, `${generatorId} must pass the gate untouched`);
      assert.equal(v.reason, 'no-concept');
    }
  });

  test('a component-template action type with nothing configured is blocked as missing', () => {
    const v = componentTemplateVerification({ url_file_map: {} }, 'faq');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'missing');
    assert.equal(v.componentKey, 'faq');
    assert.equal(v.actionType, 'faq');
  });

  test('reads the stamp through the real url_file_map.siteRoot.componentTemplates shape', () => {
    const site = {
      url_file_map: {
        siteRoot: {
          componentTemplates: {
            faq: stampTemplateVerification(VALID_FAQ, { verifiedBy: TEMPLATE_VERIFIED_BY.FRESHNESS_CHECK, verifiedRef: 'https://example.com/' }),
          },
        },
      },
    };
    const v = componentTemplateVerification(site, 'faq');
    assert.equal(v.ok, true);
    assert.equal(v.verifiedBy, 'freshness-check');
  });

  test('a compliance generator is checked against the contentWrapper entry, not its own name', () => {
    const site = {
      url_file_map: {
        siteRoot: {
          componentTemplates: {
            contentWrapper: stampTemplateVerification({ wrapper: '<article>{{BODY}}</article>' }, { verifiedBy: TEMPLATE_VERIFIED_BY.HUMAN }),
          },
        },
      },
    };
    const v = componentTemplateVerification(site, componentTemplateActionTypeFor('privacy-policy'));
    assert.equal(v.ok, true);
    assert.equal(v.componentKey, 'contentWrapper');
  });
});

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
    assert.equal(result.template.wrapper, derived.wrapper);
    assert.equal(result.template.verifiedBy, 'design-agent');
    assert.equal(saved.siteId, site.id);
    assert.equal(saved.urlFileMap.siteRoot.componentTemplates.contentWrapper.wrapper, derived.wrapper);
    assert.equal(audited.event.action, 'tenant.component_template_auto_created');
    assert.equal(audited.req.userId, null, 'no human triggered this — system actor, not a staff user');
  });

  test('a derived template missing its required placeholder is rejected, not saved, and recorded to agent_fix_memory', async () => {
    const site = { ...baseSite };
    const createHandler = () => async () => ({ componentTemplates: { 'content-wrapper': { wrapper: '<div>no body slot here</div>' } } });
    const saveConfig = async () => { throw new Error('should never be called — invalid template must not be saved'); };
    let recorded = null;
    const recordFixOutcomeFn = async (args) => { recorded = args; return 'memory-id-123'; };
    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', { createHandler, saveConfig, recordFixOutcomeFn });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-placeholders');
    assert.equal(recorded.generatorId, 'design-agent-component-templates');
    assert.equal(recorded.siteId, site.id);
    assert.equal(recorded.outcome, 'success');
    assert.equal(recorded.problemSignature, 'missing-placeholders:content-wrapper');
    assert.match(recorded.symptoms, /content-wrapper/);
  });

  test('a memory-write failure while recording a rejected template never blocks the caller', async () => {
    const site = { ...baseSite };
    const createHandler = () => async () => ({ componentTemplates: { 'content-wrapper': { wrapper: '<div>no body slot here</div>' } } });
    const saveConfig = async () => { throw new Error('should never be called — invalid template must not be saved'); };
    const recordFixOutcomeFn = async () => { throw new Error('DB is down'); };
    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', { createHandler, saveConfig, recordFixOutcomeFn });
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
