import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLiteralClassNames, extractStylesheetHrefs, checkTemplateFreshness,
  templateActionRequiresRow, resolveOrCreateComponentTemplate,
  isTemplateVerified, stampTemplateVerification, componentTemplateVerification,
  componentTemplateActionTypeFor, TEMPLATE_VERIFIED_BY,
  persistDerivedComponentTemplates, sitePageUrl, verifyTemplateAgainstLiveSite,
  contentWrapperAvailability, filterTemplateToLiveClasses,
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

describe('contentWrapperAvailability — a looser rule for the one type with a real fallback', () => {
  // newpage-render.js's wrapInSiteProse already degrades gracefully:
  // configured template -> project from the profile -> bare body. The gate
  // used to insist on a stored template regardless, which is what blocked 28
  // real blog-outline recommendations on site 1 while the apply path had a
  // perfectly good fallback ready to use.
  const PROFILE = {
    version: 1, styling: 'tailwind',
    typography: { body: 'text-gray-600', heading: { item: 'text-lg font-medium' } },
    layout: { container: 'max-w-3xl' }, components: {},
    derivedAt: '2026-08-01T00:00:00.000Z', derivedBy: 'design-agent',
  };

  test('a verified stored template still wins, same as every other type', () => {
    const site = {
      url_file_map: { siteRoot: { componentTemplates: {
        contentWrapper: stampTemplateVerification({ wrapper: '<div>{{BODY}}</div>' }, { verifiedBy: TEMPLATE_VERIFIED_BY.FRESHNESS_CHECK }),
      } } },
    };
    const v = componentTemplateVerification(site, componentTemplateActionTypeFor('blog-outline'));
    assert.equal(v.ok, true);
    assert.equal(v.componentKey, 'contentWrapper');
  });

  test('no stored template, but a usable design profile — ok, apply-time projection will cover it', () => {
    const site = { url_file_map: { siteRoot: { designProfile: PROFILE } } };
    const v = componentTemplateVerification(site, componentTemplateActionTypeFor('blog-outline'));
    assert.equal(v.ok, true);
    assert.equal(v.reason, 'projectable-from-profile');
  });

  test('neither a stored template nor a profile — genuinely blocked, with an honest reason', () => {
    const site = { url_file_map: {} };
    const v = componentTemplateVerification(site, componentTemplateActionTypeFor('blog-outline'));
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'design-language-not-derived');
    assert.match(v.detail, /Design Agent has been queued/);
    assert.doesNotMatch(v.detail, /No component template is configured/,
      'must not show the old misleading message — a human was never asked to configure one');
  });

  test('every OTHER action type keeps the strict rule — a usable profile does not silently unblock faq', () => {
    const site = { url_file_map: { siteRoot: { designProfile: PROFILE } } };
    const v = componentTemplateVerification(site, 'faq');
    assert.equal(v.ok, false, 'faq/qa-content/expand-content/internal-links still require an actual stored template');
  });
});

describe('filterTemplateToLiveClasses', () => {
  const css = '.max-w-none{a}.pb-16{a}.md\\:pb-24{a}';

  test('drops classes the live CSS does not define, keeps the ones it does', () => {
    const template = { wrapper: '<div class="prose prose-lg max-w-none pb-16 md:pb-24">{{BODY}}</div>' };
    const { template: filtered, dropped } = filterTemplateToLiveClasses(template, css);
    assert.equal(filtered.wrapper, '<div class="max-w-none pb-16 md:pb-24">{{BODY}}</div>');
    assert.deepEqual(dropped.sort(), ['prose', 'prose-lg']);
  });

  test('drops the whole class attribute when nothing survives, rather than emitting class=""', () => {
    const template = { wrapper: '<div class="prose prose-lg">{{BODY}}</div>' };
    const { template: filtered } = filterTemplateToLiveClasses(template, css);
    assert.equal(filtered.wrapper, '<div>{{BODY}}</div>');
  });

  test('never touches a placeholder token or an Alpine :class binding', () => {
    const template = {
      wrapper: '<div :class="{ \'x\': open }" class="prose">{{ROWS}}</div>',
      row: '<span class="{{FOO}} prose">{{QUESTION}}</span>',
    };
    const { template: filtered } = filterTemplateToLiveClasses(template, css);
    assert.match(filtered.wrapper, /:class="\{ 'x': open \}"/, 'the Alpine binding must be left completely alone');
    assert.match(filtered.row, /\{\{FOO\}\}/, 'a placeholder token is never treated as a real class to check');
  });

  test('leaves a template with no class attributes at all untouched', () => {
    const template = { wrapper: '<div>{{BODY}}</div>' };
    const { template: filtered, dropped } = filterTemplateToLiveClasses(template, css);
    assert.equal(filtered.wrapper, template.wrapper);
    assert.deepEqual(dropped, []);
  });

  test('a template with no row (content-wrapper shape) is filtered without erroring on the missing field', () => {
    const template = { wrapper: '<div class="prose">{{BODY}}</div>' };
    const { template: filtered } = filterTemplateToLiveClasses(template, css);
    assert.equal(filtered.wrapper, '<div>{{BODY}}</div>');
    assert.equal('row' in filtered, false);
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

  const verifiedWrapper = {
    wrapper: '<div>{{BODY}}</div>',
    verifiedAt: '2026-08-01T00:00:00.000Z',
    verifiedBy: 'design-agent',
  };

  // A minimal but usable site design language. Templates are now PROJECTIONS
  // of this rather than separately derived markup, so most of what this
  // function does is decide whether the site has design knowledge yet.
  const PROFILE = {
    version: 1,
    styling: 'tailwind',
    typography: { heading: { item: 'text-lg font-medium' }, body: 'text-gray-600', link: 'text-blue-600' },
    layout: { container: 'max-w-3xl mx-auto', prose: 'prose' },
    components: {},
    derivedAt: '2026-08-01T00:00:00.000Z',
    derivedBy: 'design-agent',
  };
  const siteWithProfile = (extra = {}) => ({
    ...baseSite,
    url_file_map: { siteRoot: { designProfile: PROFILE, ...(extra.siteRoot || {}) } },
  });
  const noopDeps = () => ({
    saveConfig: async ({ urlFileMap }) => ({ id: 1, url_file_map: urlFileMap }),
    recordAudit: async () => {},
    enqueueProfileDerivation: async () => { throw new Error('should not queue — the site already has a profile'); },
    enqueueDerivation: async () => { throw new Error('should not queue a per-type derivation'); },
    findQueuedDerivation: async () => null,
    latestDesignAgentJob: async () => null,
  });

  test('returns an existing VERIFIED template immediately', async () => {
    const site = { ...baseSite, url_file_map: { siteRoot: { componentTemplates: { contentWrapper: verifiedWrapper } } } };
    const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', noopDeps());
    assert.equal(result.ok, true);
    assert.equal(result.source, 'existing');
  });

  test('PROJECTS a missing template from the site design profile — no repo analysis', async () => {
    // The architecture: one site-wide analysis, many component projections.
    // A site that knows its own design language gains a new design-sensitive
    // content type instantly, without another Design Agent session.
    let saved = null;
    const result = await resolveOrCreateComponentTemplate(siteWithProfile(), 'faq', {
      ...noopDeps(),
      saveConfig: async ({ urlFileMap }) => { saved = urlFileMap; return { id: 1, url_file_map: urlFileMap }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'design-profile');
    assert.match(result.template.wrapper, /max-w-3xl mx-auto/, 'uses the site\'s real container');
    assert.match(result.template.row, /text-lg font-medium/, 'uses the site\'s real heading style');
    assert.equal(result.template.verifiedBy, 'design-agent', 'a projection carries provenance like any other template');
    assert.ok(saved.siteRoot.componentTemplates.faq, 'the projection is persisted, not recomputed every call');
  });

  test('an UNVERIFIED existing template is replaced by a projection when a profile exists', async () => {
    // Also the fallthrough regression test: this site (baseSite) has no
    // website_domain, so the self-heal step below gets 'unreachable' from
    // verifyTemplateAgainstLiveSite before it can even check any CSS. It used
    // to treat that as a dead end and return early — 'unreachable' must fall
    // through to this projection path instead, since a network blip fetching
    // the live page says nothing about whether the cheap, no-network
    // projection below can succeed.
    const site = siteWithProfile({ siteRoot: { componentTemplates: { faq: { wrapper: '<dl>{{ROWS}}</dl>' } } } });
    const result = await resolveOrCreateComponentTemplate(site, 'faq', noopDeps());
    assert.equal(result.ok, true);
    assert.equal(result.source, 'design-profile');
  });

  test('an UNVERIFIED existing template with real markup is self-healed by a live-CSS check, not replaced', async () => {
    // The self-heal check runs BEFORE the projection path — for a template
    // that is merely unstamped and genuinely matches the live site, checking
    // is strictly better than replacing real repo-derived markup with a
    // composed approximation, even when a profile is available to fall back
    // on.
    const wrapper = '<section class="py-12"><div class="divide-y divide-gray-200">{{ROWS}}</div></section>';
    const row = '<div class="py-5"><span>{{QUESTION}}</span><p>{{ANSWER}}</p></div>';
    const site = {
      ...siteWithProfile({ siteRoot: { componentTemplates: { faq: { wrapper, row } } } }),
      website_domain: 'zunkireelabs.com',
    };
    let saved = null;

    const result = await resolveOrCreateComponentTemplate(site, 'faq', {
      ...noopDeps(),
      saveConfig: async ({ urlFileMap }) => { saved = urlFileMap; return { id: 1, url_file_map: urlFileMap }; },
      fetchPage: async () => '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
      fetchStylesheet: async () => '.py-12{a}.divide-y>:not([hidden]){a}.divide-gray-200{a}.py-5{a}',
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'freshness-check');
    assert.equal(result.template.wrapper, wrapper, 'the real markup is preserved, not replaced by a projection');
    assert.ok(saved.siteRoot.componentTemplates.faq.verifiedAt);
  });


  test('every projectable type resolves from ONE profile', async () => {
    for (const actionType of ['faq', 'qa-content', 'expand-content', 'internal-links', 'content-wrapper']) {
      const result = await resolveOrCreateComponentTemplate(siteWithProfile(), actionType, noopDeps());
      assert.equal(result.ok, true, `${actionType} should project`);
      assert.equal(result.source, 'design-profile');
    }
  });

  // The trap this closes: a projection composes from designProfile fields
  // (e.g. layout.prose), and those can describe a class the site's shipped
  // CSS never actually defines — zunkireelabs.com's real profile would carry
  // `prose prose-lg prose-gray max-w-none` for layout.prose, but
  // @tailwindcss/typography is not installed there, so .prose* ships zero
  // rules. Stamping that unconditionally would "unblock" a contentWrapper
  // recommendation with a wrapper that renders invisibly.
  describe('projections are verified against the live site before being trusted', () => {
    // siteWithProfile only ever merges extra.siteRoot, so website_domain has
    // to be applied on top of its result, not passed through it.
    const liveSite = (extra = {}) => ({ ...siteWithProfile(extra), website_domain: 'zunkireelabs.com' });
    const html = '<html><head><link rel="stylesheet" href="/main.css"></head></html>';

    test('a projection whose classes are all live is stamped freshness-check, the strongest evidence', async () => {
      // max-w-3xl mx-auto (container) and text-lg/text-gray-600/text-blue-600
      // (typography) are all "live" here — only prose is missing, and this
      // scenario checks content-wrapper, which composes container + prose.
      // Use a profile with no prose reference so nothing needs filtering.
      const site = liveSite({
        siteRoot: { designProfile: { ...PROFILE, layout: { container: 'max-w-3xl mx-auto' } } },
      });
      let saved = null;
      const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', {
        ...noopDeps(),
        saveConfig: async ({ urlFileMap }) => { saved = urlFileMap; },
        fetchPage: async () => html,
        fetchStylesheet: async () => '.max-w-3xl{a}.mx-auto{a}',
      });
      assert.equal(result.ok, true);
      assert.equal(result.source, 'design-profile');
      assert.equal(result.template.verifiedBy, 'freshness-check', 'live evidence beats the unconditional design-agent stamp');
      assert.equal(result.template.verifiedRef, 'https://zunkireelabs.com');
      assert.equal(saved.siteRoot.componentTemplates.contentWrapper.verifiedBy, 'freshness-check');
    });

    test('a projection referencing a class the live site does not ship is filtered, not stamped as-is', async () => {
      // The exact zunkireelabs.com shape: layout.prose composes into the
      // wrapper, but .prose ships zero rules.
      const site = liveSite({
        siteRoot: { designProfile: { ...PROFILE, layout: { container: 'max-w-3xl mx-auto', prose: 'prose prose-lg' } } },
      });
      let saved = null;
      const result = await resolveOrCreateComponentTemplate(site, 'content-wrapper', {
        ...noopDeps(),
        saveConfig: async ({ urlFileMap }) => { saved = urlFileMap; },
        fetchPage: async () => html,
        fetchStylesheet: async () => '.max-w-3xl{a}.mx-auto{a}', // no .prose or .prose-lg
      });
      assert.equal(result.ok, true);
      assert.equal(result.source, 'design-profile');
      assert.equal(result.template.verifiedBy, 'freshness-check', 'the FILTERED template still gets real live evidence');
      assert.doesNotMatch(result.template.wrapper, /\bprose\b/, 'the class the live site does not ship must not survive');
      assert.match(result.template.wrapper, /max-w-3xl mx-auto/, 'classes that DO ship are preserved');
      assert.deepEqual(saved.siteRoot.componentTemplates.contentWrapper.droppedClasses.sort(), ['prose', 'prose-lg']);
    });

    test('an unreachable live site falls back to the unconditional design-agent stamp, not a crash', async () => {
      const site = liveSite();
      const result = await resolveOrCreateComponentTemplate(site, 'faq', {
        ...noopDeps(),
        fetchPage: async () => null,
      });
      assert.equal(result.ok, true);
      assert.equal(result.source, 'design-profile');
      assert.equal(result.template.verifiedBy, 'design-agent', 'no live evidence available — falls back exactly as before this existed');
    });
  });

  test('with NO profile, queues a whole-site design derivation, not a per-type one', async () => {
    // The key architectural assertion: the missing thing is the site's design
    // language, so that is what gets derived — one job that yields every
    // projectable template, not one job per content type.
    const queued = [];
    const result = await resolveOrCreateComponentTemplate(baseSite, 'faq', {
      ...noopDeps(),
      enqueueProfileDerivation: async (siteId, opts) => { queued.push([siteId, opts]); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'derivation-queued');
    assert.equal(queued.length, 1);
    assert.equal(queued[0][0], 1);
    assert.match(result.detail, /design language/i);
  });

  test('does not queue a second profile derivation when one is already pending', async () => {
    const queued = [];
    const result = await resolveOrCreateComponentTemplate(baseSite, 'faq', {
      ...noopDeps(),
      findQueuedDerivation: async () => ({ id: 99 }),
      enqueueProfileDerivation: async (...a) => { queued.push(a); },
    });
    assert.equal(result.reason, 'derivation-queued');
    assert.deepEqual(queued, []);
  });

  describe('waitForCompletion (the cron/auto-remediation same-pass wait)', () => {
    test('polls the freshly-queued job and retries once it completes, returning a real template', async () => {
      const polled = [];
      const result = await resolveOrCreateComponentTemplate(baseSite, 'faq', {
        ...noopDeps(),
        enqueueProfileDerivation: async () => ({ id: 42 }),
        waitForCompletion: true,
        sleep: async () => {},
        pollJobStatus: async (jobId) => {
          polled.push(jobId);
          return polled.length < 2 ? { id: jobId, status: 'executing' } : { id: jobId, status: 'completed' };
        },
        refetchSite: async () => siteWithProfile(),
      });
      assert.equal(result.ok, true);
      assert.equal(result.source, 'design-profile', 'the retry against the refetched (now-profiled) site succeeds');
      assert.equal(polled.length, 2, 'polled until the job left queued/executing');
    });

    test('waits on an ALREADY-queued job (not just a freshly-created one)', async () => {
      const result = await resolveOrCreateComponentTemplate(baseSite, 'faq', {
        ...noopDeps(),
        findQueuedDerivation: async () => ({ id: 7 }),
        waitForCompletion: true,
        sleep: async () => {},
        pollJobStatus: async (jobId) => ({ id: jobId, status: 'completed' }),
        refetchSite: async () => siteWithProfile(),
      });
      assert.equal(result.ok, true);
      assert.equal(result.source, 'design-profile');
    });

    test('falls back to the ordinary "queued" result when the job fails within the wait budget', async () => {
      const result = await resolveOrCreateComponentTemplate(baseSite, 'faq', {
        ...noopDeps(),
        enqueueProfileDerivation: async () => ({ id: 42 }),
        waitForCompletion: true,
        sleep: async () => {},
        pollJobStatus: async (jobId) => ({ id: jobId, status: 'failed' }),
        refetchSite: async () => { throw new Error('should not refetch — the job failed'); },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'derivation-queued');
    });

    test('falls back to the ordinary "queued" result when the wait budget is exhausted', async () => {
      let sleeps = 0;
      const result = await resolveOrCreateComponentTemplate(baseSite, 'faq', {
        ...noopDeps(),
        enqueueProfileDerivation: async () => ({ id: 42 }),
        waitForCompletion: true,
        waitBudgetMs: 1,
        sleep: async () => { sleeps++; },
        pollJobStatus: async (jobId) => ({ id: jobId, status: 'executing' }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'derivation-queued');
      assert.ok(sleeps >= 0, 'never hangs even when the deadline is effectively immediate');
    });

    test('never queues a second job on the post-completion retry', async () => {
      let enqueueCalls = 0;
      const result = await resolveOrCreateComponentTemplate(baseSite, 'faq', {
        ...noopDeps(),
        enqueueProfileDerivation: async () => { enqueueCalls++; return { id: 42 }; },
        waitForCompletion: true,
        sleep: async () => {},
        pollJobStatus: async (jobId) => ({ id: jobId, status: 'completed' }),
        refetchSite: async () => siteWithProfile(),
      });
      assert.equal(result.ok, true);
      assert.equal(enqueueCalls, 1, 'the retry runs with waitForCompletion off, so it can never re-enqueue or loop');
    });
  });

  test('a failed enqueue is surfaced honestly, not papered over as "queued, no action needed"', async () => {
    const result = await resolveOrCreateComponentTemplate(baseSite, 'faq', {
      ...noopDeps(),
      enqueueProfileDerivation: async () => { throw new Error('insert failed: connection reset'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'derivation-queue-failed');
    assert.doesNotMatch(result.detail, /connection reset/);
    assert.match(result.detail, /queuing the Design Agent to learn it just failed/);
    assert.match(result.detail, /will not resolve on its own/);
  });

  test('a prior FAILED derivation with nothing newly pending says so, instead of repeating a stale "queued" claim', async () => {
    const result = await resolveOrCreateComponentTemplate(baseSite, 'faq', {
      ...noopDeps(),
      enqueueProfileDerivation: async () => {}, // re-enqueue "succeeds" (a fresh job is queued)...
      latestDesignAgentJob: async () => ({ id: 3008, status: 'failed', finished_at: '2026-08-12T11:33:03.143Z' }), // ...but the LAST one on record failed
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'derivation-retry-queued');
    assert.match(result.detail, /job #3008/);
    assert.match(result.detail, /engineer needs to check the worker logs/);
  });

  test('action type with no component-template concept short-circuits', async () => {
    const result = await resolveOrCreateComponentTemplate(baseSite, 'meta-title', noopDeps());
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-concept');
  });

  test('site without design_agent_enabled reports not-available, and queues nothing', async () => {
    const result = await resolveOrCreateComponentTemplate({ ...baseSite, design_agent_enabled: false }, 'faq', noopDeps());
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-available');
  });

  test('site with no repo configured reports not-available', async () => {
    const result = await resolveOrCreateComponentTemplate({ ...baseSite, repo_owner: null, repo_name: null }, 'faq', noopDeps());
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-available');
  });

  test('an unusable profile is treated as no profile at all', async () => {
    // A half-derived profile must not silently produce half-designed markup.
    const queued = [];
    const site = { ...baseSite, url_file_map: { siteRoot: { designProfile: { version: 1 } } } };
    const result = await resolveOrCreateComponentTemplate(site, 'faq', {
      ...noopDeps(),
      enqueueProfileDerivation: async (...a) => { queued.push(a); },
    });
    assert.equal(result.reason, 'derivation-queued');
    assert.equal(queued.length, 1);
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

  // Regression: real Tailwind output for divide-*/space-y-* utilities is
  // `.divide-y>:not([hidden])~:not([hidden]){...}` — the class is followed by
  // `>`, never by `{`/`:`/`,`/space. Verified against the real shipped CSS at
  // zunkireelabs.com, where classExistsInCss's old enumerate-what-can-follow
  // list did not include `>` and so reported divide-y, divide-gray-200 and
  // space-y-3 as missing on every single check — the actual reason site 1's
  // faq and internalLinks templates never got stamped, despite using markup
  // that matched the live site exactly.
  test('a class followed by a combinator selector (Tailwind divide-*/space-y-*) is not flagged missing', async () => {
    const divideTemplate = { wrapper: '<div class="divide-y divide-gray-200">{{ROWS}}</div>' };
    const css = '.divide-y>:not([hidden])~:not([hidden]){border-top-width:1px}.divide-gray-200{--tw-divide-opacity:1}';
    const result = await checkTemplateFreshness({
      pageUrl: 'https://example.com/page/', templateEntry: divideTemplate,
      fetchPage: async () => html, fetchStylesheet: async () => css,
    });
    assert.equal(result.stale, false);
    assert.deepEqual(result.missingClasses, []);
  });

  test('still does not match a class name that is merely a PREFIX of a longer one', async () => {
    // The combinator fix must not regress the substring-safety test above:
    // '.divide-y-custom' must not satisfy a check for 'divide-y'.
    const divideTemplate = { wrapper: '<div class="divide-y">{{ROWS}}</div>' };
    const css = '.divide-y-custom{color:red}';
    const result = await checkTemplateFreshness({
      pageUrl: 'https://example.com/page/', templateEntry: divideTemplate,
      fetchPage: async () => html, fetchStylesheet: async () => css,
    });
    assert.equal(result.stale, true);
    assert.deepEqual(result.missingClasses, ['divide-y']);
  });
});

describe('verifyTemplateAgainstLiveSite', () => {
  const wrapper = '<section class="py-12"><div class="divide-y divide-gray-200">{{ROWS}}</div></section>';
  const row = '<div class="py-5"><span>{{QUESTION}}</span><p>{{ANSWER}}</p></div>';
  const liveCss = '.py-12{a}.divide-y>:not([hidden]){a}.divide-gray-200{a}.py-5{a}';
  const html = '<html><head><link rel="stylesheet" href="/assets/main.css"></head></html>';

  test('a real, live-matching template is verified and stamped freshness-check', async () => {
    const result = await verifyTemplateAgainstLiveSite('faq', { wrapper, row }, {
      pageUrl: 'https://zunkireelabs.com', fetchPage: async () => html, fetchStylesheet: async () => liveCss,
    });
    assert.equal(result.ok, true);
    assert.equal(result.stamped.verifiedBy, 'freshness-check');
    assert.equal(result.stamped.verifiedRef, 'https://zunkireelabs.com');
    assert.equal(result.stamped.wrapper, wrapper, 'markup preserved exactly');
  });

  test('a template missing a required placeholder is rejected before any network call', async () => {
    let fetched = false;
    const result = await verifyTemplateAgainstLiveSite('faq', { wrapper: '<dl>{{ROWS}}</dl>' }, {
      pageUrl: 'https://zunkireelabs.com', fetchPage: async () => { fetched = true; return html; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-placeholders');
    assert.equal(fetched, false, 'a deterministic string check should never cost a network round trip');
  });

  test('a template claiming a purged class is rejected as stale, not stamped', async () => {
    const cssWithoutDivide = liveCss.replace('.divide-y>:not([hidden]){a}', '');
    const result = await verifyTemplateAgainstLiveSite('faq', { wrapper, row }, {
      pageUrl: 'https://zunkireelabs.com', fetchPage: async () => html, fetchStylesheet: async () => cssWithoutDivide,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale');
    assert.deepEqual(result.missingClasses, ['divide-y']);
  });

  test('a classless template has no design claims to verify, even if reachable', async () => {
    const result = await verifyTemplateAgainstLiveSite('content-wrapper', { wrapper: '<div>{{BODY}}</div>' }, {
      pageUrl: 'https://zunkireelabs.com', fetchPage: async () => html, fetchStylesheet: async () => liveCss,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-design-claims');
  });

  test('an unreachable page fails as unreachable, never as stale', async () => {
    const result = await verifyTemplateAgainstLiveSite('faq', { wrapper, row }, {
      pageUrl: 'https://zunkireelabs.com', fetchPage: async () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unreachable');
  });

  test('no page URL at all is unreachable, not a crash', async () => {
    const result = await verifyTemplateAgainstLiveSite('faq', { wrapper, row }, {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unreachable');
  });
});
