import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLiteralClassNames, extractStylesheetHrefs, checkTemplateFreshness,
  templateActionRequiresRow, resolveOrCreateComponentTemplate,
  isTemplateVerified, stampTemplateVerification, componentTemplateVerification,
  componentTemplateActionTypeFor, TEMPLATE_VERIFIED_BY,
  persistDerivedComponentTemplates, sitePageUrl,
} from './design-drift.js';

const VALID_FAQ = { wrapper: '<div class="faq">{{ROWS}}</div>', row: '<dt>{{QUESTION}}</dt><dd>{{ANSWER}}</dd>' };

describe('stampTemplateVerification', () => {
  test('attaches provenance without mutating the original', () => {
    const stamped = stampTemplateVerification(VALID_FAQ, { verifiedBy: TEMPLATE_VERIFIED_BY.DESIGN_AGENT, verifiedRef: 42 });
    assert.equal(VALID_FAQ.verifiedAt, undefined, 'must not mutate the caller\'s object');
    assert.equal(stamped.verifiedBy, 'design-agent');
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
    const stamped = stampTemplateVerification({ wrapper: '<div>{{ROWS}}</div>', row: '<dd>{{ANSWER}}</dd>' }, { verifiedBy: TEMPLATE_VERIFIED_BY.DESIGN_AGENT });
    const v = isTemplateVerified('faq', stamped);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'invalid-placeholders', 'missing {{QUESTION}} still fails even though it is stamped');
  });

  test('makes no network call — safe on the hot path in generateDraft and the per-finding loop', () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('isTemplateVerified must never fetch'); };
    try {
      assert.equal(isTemplateVerified('faq', stampTemplateVerification(VALID_FAQ, { verifiedBy: TEMPLATE_VERIFIED_BY.DESIGN_AGENT })).ok, true);
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

  // These four render the same single-{{BODY}} whole-page shape as the
  // compliance trio (newpage-render.js) but had no component-template concept
  // at all, so both gates saw 'no-concept' and waved them through while their
  // bodies shipped with no site prose wrapper — bare unstyled headings into a
  // real PR.
  test('every other net-new whole-page generator shares content-wrapper too', () => {
    assert.equal(componentTemplateActionTypeFor('landing-page'), 'content-wrapper');
    assert.equal(componentTemplateActionTypeFor('blog-outline'), 'content-wrapper');
    assert.equal(componentTemplateActionTypeFor('direct-answer'), 'content-wrapper');
    assert.equal(componentTemplateActionTypeFor('translation'), 'content-wrapper');
  });

  test('every other generator maps to itself', () => {
    assert.equal(componentTemplateActionTypeFor('faq'), 'faq');
    assert.equal(componentTemplateActionTypeFor('meta-title'), 'meta-title');
  });
});

describe('sitePageUrl', () => {
  test('prefers the configured website_domain, normalized to an absolute URL', () => {
    assert.equal(sitePageUrl({ website_domain: 'example.com' }), 'https://example.com');
    assert.equal(sitePageUrl({ website_domain: 'https://example.com' }), 'https://example.com');
  });

  test('falls back to gsc_property with its sc-domain: prefix stripped', () => {
    assert.equal(sitePageUrl({ gsc_property: 'sc-domain:example.com' }), 'https://example.com');
  });

  test('null when the site has neither — callers treat that as "cannot check"', () => {
    assert.equal(sitePageUrl({}), null);
    assert.equal(sitePageUrl(null), null);
  });
});

describe('persistDerivedComponentTemplates', () => {
  const site = { id: 7, name: 'Acme', url_file_map: { pages: { '/': 'src/index.njk' } } };
  const noop = async () => {};

  test('validates, stamps and saves every derived template in ONE config write', async () => {
    const saves = [];
    const audits = [];
    const result = await persistDerivedComponentTemplates(site, {
      faq: VALID_FAQ,
      'content-wrapper': { wrapper: '<article class="prose">{{BODY}}</article>' },
    }, { jobId: 42, saveConfig: async (a) => saves.push(a), recordAudit: async (_req, e) => audits.push(e) });

    assert.equal(result.ok, true);
    assert.equal(saves.length, 1, 'one write for both keys, not one per key');
    const stored = saves[0].urlFileMap.siteRoot.componentTemplates;
    assert.deepEqual(Object.keys(stored).sort(), ['contentWrapper', 'faq']);
    assert.equal(stored.faq.verifiedBy, TEMPLATE_VERIFIED_BY.DESIGN_AGENT);
    assert.equal(stored.faq.verifiedRef, '42');
    assert.ok(stored.contentWrapper.verifiedAt);
    assert.equal(saves[0].urlFileMap.pages['/'], 'src/index.njk', 'unrelated url_file_map config is preserved');
    assert.equal(audits.length, 2, 'one audit event per saved template');
  });

  test('a template missing its required placeholder is rejected and recorded, and never reaches the write', async () => {
    const saves = [];
    const lessons = [];
    const result = await persistDerivedComponentTemplates(site, {
      faq: { wrapper: '<div>{{ROWS}}</div>', row: '<div>nothing here</div>' },
    }, { saveConfig: async (a) => saves.push(a), recordAudit: noop, recordFixOutcomeFn: async (l) => lessons.push(l) });

    assert.equal(result.ok, false);
    assert.deepEqual(saves, [], 'nothing written when every candidate was rejected');
    assert.equal(result.rejected[0].reason, 'invalid-placeholders');
    assert.equal(lessons.length, 1, 'the rejection is recorded to agent_fix_memory for the next derivation');
  });

  test('one bad template does not block the good ones alongside it', async () => {
    const saves = [];
    const result = await persistDerivedComponentTemplates(site, {
      faq: VALID_FAQ,
      'expand-content': { wrapper: '<div>{{ROWS}}</div>', row: '<div>no tokens</div>' },
    }, { saveConfig: async (a) => saves.push(a), recordAudit: noop, recordFixOutcomeFn: noop });

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.saved), ['faq']);
    assert.deepEqual(Object.keys(saves[0].urlFileMap.siteRoot.componentTemplates), ['faq']);
    assert.equal(result.rejected[0].actionType, 'expand-content');
  });

  test('an action type with no component-template concept is skipped, not saved under a bogus key', async () => {
    const saves = [];
    const result = await persistDerivedComponentTemplates(site, {
      'meta-title': { wrapper: '<title>{{ROWS}}</title>' },
    }, { saveConfig: async (a) => saves.push(a), recordAudit: noop, recordFixOutcomeFn: noop });

    assert.equal(result.ok, false);
    assert.deepEqual(saves, []);
    assert.equal(result.rejected[0].reason, 'no-concept');
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
            contentWrapper: stampTemplateVerification({ wrapper: '<article>{{BODY}}</article>' }, { verifiedBy: TEMPLATE_VERIFIED_BY.DESIGN_AGENT }),
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

  // The fast path requires the template to be VERIFIED, not merely present.
  // This test previously used an unstamped template and asserted ok:true —
  // which was the bug: an unverified template short-circuited the Design
  // Agent here, then got 422'd by the gate in generateDraft, permanently,
  // with nothing able to re-derive it.
  const verifiedWrapper = {
    wrapper: '<div>{{BODY}}</div>',
    verifiedAt: '2026-08-01T00:00:00.000Z',
    verifiedBy: 'design-agent',
  };

  test('returns an existing VERIFIED template immediately without touching the Design Agent', async () => {
    const site = { ...baseSite, url_file_map: { siteRoot: { componentTemplates: { contentWrapper: verifiedWrapper } } } };
    const createHandler = () => { throw new Error('should never be called — a verified template already exists'); };
    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', { createHandler });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'existing');
    assert.equal(result.template.wrapper, '<div>{{BODY}}</div>');
  });

  test('an existing UNVERIFIED template queues re-derivation instead of being accepted', async () => {
    const site = { ...baseSite, url_file_map: { siteRoot: { componentTemplates: { contentWrapper: { wrapper: '<div>{{BODY}}</div>' } } } } };
    const enqueued = [];
    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', {
      createHandler: () => { throw new Error('must not run an OpenHands session on the hot path'); },
      enqueueDerivation: async (siteId, keys) => { enqueued.push([siteId, keys]); },
      findQueuedDerivation: async () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'derivation-queued');
    assert.deepEqual(enqueued, [[1, ['content-wrapper']]], 'queued by ACTION TYPE, matching what the job stores');
  });

  test('does not queue a second job when one is already pending for that action type', async () => {
    // resolveOrCreate sits on generateDraft's hot path — without this check a
    // single daily run against a blocked site would queue dozens of jobs for
    // work already pending.
    const site = { ...baseSite, url_file_map: { siteRoot: { componentTemplates: { contentWrapper: { wrapper: '<div>{{BODY}}</div>' } } } } };
    const enqueued = [];
    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', {
      createHandler: () => { throw new Error('should never be called'); },
      enqueueDerivation: async (...args) => { enqueued.push(args); },
      findQueuedDerivation: async () => ({ id: 99 }),
    });
    assert.equal(result.reason, 'derivation-queued');
    assert.deepEqual(enqueued, []);
  });

  test('an unverified template on a site without the Design Agent reports not-available, not queued', async () => {
    // Nothing can re-derive it, so promising "queued, resolves shortly" would
    // be a lie.
    const site = {
      ...baseSite, design_agent_enabled: false,
      url_file_map: { siteRoot: { componentTemplates: { contentWrapper: { wrapper: '<div>{{BODY}}</div>' } } } },
    };
    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', {
      createHandler: () => { throw new Error('should never be called'); },
      enqueueDerivation: async () => { throw new Error('should never queue'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-available');
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
