import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// mock.module (Node 20.6+, --experimental-test-module-mocks — same
// convention as auto-remediation.test.js) swaps out the real DB-writing
// store module so checkDesignIntegrityGate's tests below exercise its own
// control flow (no-profile passthrough, log-only vs. enforce, the verdict
// shape) without a live Postgres connection.
const resolve = (p) => new URL(p, import.meta.url).href;
const recordedVerdicts = [];
mock.module(resolve('../../store/design-integrity-verdicts.js'), {
  namedExports: {
    recordDesignIntegrityVerdict: async (args) => { recordedVerdicts.push(args); },
  },
});

const {
  extractLiteralClassNames, extractStylesheetHrefs, checkTemplateFreshness, checkTemplateStructuralMatch,
  templateActionRequiresRow, resolveOrCreateComponentTemplate,
  isTemplateVerified, stampTemplateVerification, componentTemplateVerification,
  componentTemplateActionTypeFor, TEMPLATE_VERIFIED_BY,
  persistDerivedComponentTemplates, sitePageUrl, verifyTemplateAgainstLiveSite,
  contentWrapperAvailability, filterTemplateToLiveClasses, withDesignContext, DESIGN_CONTEXT_GENERATOR_IDS,
  bodySlotLooksLikeLabel, captureClassRules, checkClassRuleDrift,
  observedClassesByRole, checkTypographyRole, verifyProfileRoles,
  designReviewFingerprint, designReviewState, checkDesignIntegrityGate,
  extractPageTypographyEvidence, buildPageEvidenceComponentTemplate,
  resolvePageComponentTemplate, pageTemplateFileKey, PAGE_COMPONENT_TEMPLATE_TIER,
  validatePlaceholders,
} = await import('./design-drift.js');
const { DESIGN_PROFILE_VERSION } = await import('../../design-agent/lib/design-profile.js');

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
    version: DESIGN_PROFILE_VERSION, styling: 'tailwind',
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
    assert.match(v.detail, /analysis of the live site has been queued/);
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
  const baseSite = { id: 1, name: 'Test Site', repo_owner: 'acme', repo_name: 'acme-web', auto_remediation_enabled: true, url_file_map: {} };

  const verifiedWrapper = {
    wrapper: '<div>{{BODY}}</div>',
    verifiedAt: '2026-08-01T00:00:00.000Z',
    verifiedBy: 'design-agent',
  };

  // A minimal but usable site design language. Templates are now PROJECTIONS
  // of this rather than separately derived markup, so most of what this
  // function does is decide whether the site has design knowledge yet.
  const PROFILE = {
    version: DESIGN_PROFILE_VERSION,
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

  test('a projection whose body slot is styled as a label is BLOCKED, never stamped verified', async () => {
    // The regression this whole branch exists for. Every other verification
    // failure means "we could not confirm this template", and falling through
    // to the DESIGN_AGENT stamp is defensible for those. 'body-slot-is-label'
    // means the opposite: the check ran, succeeded, and found the template
    // genuinely wrong — its prose slot carries the site's eyebrow styling.
    // Falling through stamped it verified anyway, which is precisely how five
    // templates came to read `verifiedBy: design-agent` while rendering every
    // generated paragraph as a tiny uppercase caption on a live site.
    const labelProfile = { ...PROFILE, typography: { ...PROFILE.typography, body: 'eyebrow' } };
    const site = {
      ...baseSite,
      website_domain: 'zunkireelabs.com',
      url_file_map: { siteRoot: { designProfile: labelProfile } },
    };
    let saved = null;
    let queuedFor = null;

    const result = await resolveOrCreateComponentTemplate(site, 'qa-content', {
      ...noopDeps(),
      saveConfig: async ({ urlFileMap }) => { saved = urlFileMap; return { id: 1, url_file_map: urlFileMap }; },
      enqueueProfileDerivation: async (siteId) => { queuedFor = siteId; return { id: 99 }; },
      fetchPage: async () => '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
      // Every class the projection uses really exists — so this cannot pass or
      // fail as 'stale'. Existence was never the question; role was.
      fetchStylesheet: async () => '.max-w-3xl{a}.mx-auto{a}.text-lg{a}.font-medium{a}.eyebrow{text-transform:uppercase}',
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'body-slot-is-label');
    assert.equal(result.template, null, 'no template is handed back for a draft to render with');
    assert.equal(saved, null, 'nothing is persisted — a known-bad template must not be stamped');
    assert.equal(queuedFor, site.id, 'the profile itself is re-derived, since that is where the bad body class came from');
  });

  test('a projection is NOT structurally checked — it composes new markup, it does not claim to mirror the page', async () => {
    // The admizzeducation.com incident, from the other direction. A projected
    // template for a component the site has never had cannot possibly already
    // appear on the reference page, so running the structural shape check
    // against it produces a guaranteed failure that means nothing. All five of
    // that site's templates failed exactly this way; enforcing it would leave
    // every newly onboarded client on plain unstyled defaults forever. Class
    // existence and body-slot role ARE still checked here — only shape is
    // skipped, and only for projections.
    const site = {
      ...baseSite,
      website_domain: 'admizzeducation.com',
      url_file_map: { siteRoot: { designProfile: PROFILE } },
    };
    let saved = null;

    const result = await resolveOrCreateComponentTemplate(site, 'faq', {
      ...noopDeps(),
      saveConfig: async ({ urlFileMap }) => { saved = urlFileMap; return { id: 1, url_file_map: urlFileMap }; },
      // A live page that contains no FAQ whatsoever — the exact situation a
      // first-ever FAQ projection is created in.
      fetchPage: async () => '<html><head><link rel="stylesheet" href="/main.css"></head><body><p>No FAQ on this page at all.</p></body></html>',
      fetchStylesheet: async () => '.max-w-3xl{a}.mx-auto{a}.text-lg{a}.font-medium{a}.text-gray-600{a}.prose{a}',
    });

    assert.equal(result.ok, true, 'the projection is usable despite matching no existing shape');
    assert.equal(result.source, 'design-profile');
    assert.equal(result.template.verifiedBy, 'freshness-check', 'verified on live CSS evidence, the check that IS meaningful here');
    assert.ok(saved.siteRoot.componentTemplates.faq, 'and persisted, not discarded');
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
      // Body actually contains the real shape, not just a page with the
      // right stylesheet link — the self-heal now checks structure too
      // (checkTemplateStructuralMatch), not just class-existence.
      fetchPage: async () => `<html><head><link rel="stylesheet" href="/main.css"></head><body>${wrapper.replace('{{ROWS}}', row.replace('{{QUESTION}}', 'Q?').replace('{{ANSWER}}', 'A.'))}</body></html>`,
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
    // Body actually contains a content-wrapper shape (projectContentWrapper's
    // `<div class="...">{{BODY}}</div>`, filled with real content) — the
    // structural check now runs on top of class-existence, so the fetched
    // page has to genuinely contain the wrapper's shape, not just link the
    // right stylesheet.
    const html = '<html><head><link rel="stylesheet" href="/main.css"></head>'
      + '<body><div class="max-w-3xl mx-auto">Real page content.</div></body></html>';

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

  // Eligibility no longer depends on auto_remediation_enabled — see the
  // gate's own comment in design-drift.js for why that used to be a
  // deadlock once the design-integrity gate made auto_remediation_enabled
  // itself depend on a design review having already happened. A site
  // awaiting its first review still gets its design DERIVED (so there is
  // something to review); it just can't SHIP with it yet, which is enforced
  // separately at apply time.
  test('a site awaiting its design review (auto_remediation not yet enabled) still queues derivation, same as any other site with no profile', async () => {
    const queued = [];
    const result = await resolveOrCreateComponentTemplate({ ...baseSite, auto_remediation_enabled: false }, 'faq', {
      ...noopDeps(),
      enqueueProfileDerivation: async (siteId, opts) => { queued.push([siteId, opts]); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'derivation-queued');
    assert.equal(queued.length, 1);
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

  // Regression: a site built with page-scoped inline CSS (a <style> block
  // per page, no <link rel="stylesheet"> at all — Chayce's actual design)
  // was reported stale on every page, because only linked stylesheets were
  // ever checked. The classes are real and live; they were just never
  // looked for in the one place this site actually puts them.
  test('classes defined only in an inline <style> block on the page are found, not reported missing', async () => {
    const inlineHtml = '<html><head><style>.py-12{padding-top:3rem}.text-xl{font-size:1.25rem}' +
      '.font-normal{font-weight:400}@media(min-width:768px){.md\\:py-20{padding-top:5rem}' +
      '.md\\:text-2xl{font-size:1.5rem}}</style></head><body></body></html>';
    const result = await checkTemplateFreshness({
      pageUrl: 'https://example.com/page/',
      templateEntry: template,
      fetchPage: async () => inlineHtml,
      fetchStylesheet: async () => { throw new Error('no linked stylesheet to fetch'); },
    });
    assert.equal(result.ok, true);
    assert.equal(result.stale, false);
    assert.deepEqual(result.missingClasses, []);
  });

  test('no <link rel="stylesheet"> and no inline <style> -> honest error, not a false stale verdict', async () => {
    const bareHtml = '<html><head></head><body></body></html>';
    const result = await checkTemplateFreshness({
      pageUrl: 'https://example.com/page/',
      templateEntry: template,
      fetchPage: async () => bareHtml,
      fetchStylesheet: async () => 'irrelevant',
    });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});

describe('extractPageTypographyEvidence', () => {
  test('finds the real heading and body classes on a page, ignoring nav/header/footer', () => {
    const html = '<html><body>'
      + '<nav><h2 class="nav-h2">Menu</h2></nav>'
      + '<header><p class="header-p">A header blurb long enough to look like real body copy at first glance.</p></header>'
      + '<section class="content-section"><h2 class="real-heading">A Real Section Heading</h2>'
      + '<p class="real-body">This is the real paragraph of body copy on this page, long enough to count.</p></section>'
      + '<footer><p class="footer-p">Copyright footer text that is also long enough to otherwise look like body copy.</p></footer>'
      + '</body></html>';
    const evidence = extractPageTypographyEvidence(html);
    assert.equal(evidence.headingClass, 'real-heading');
    assert.equal(evidence.bodyClass, 'real-body');
    assert.equal(evidence.containerClass, 'content-section');
  });

  test('returns null when the page has no classed heading at all — never invents one', () => {
    const html = '<html><body><h2>No class here</h2><p class="some-body">Long enough real paragraph text right here.</p></body></html>';
    assert.equal(extractPageTypographyEvidence(html), null);
  });

  test('returns null when the page has no classed paragraph long enough to count as body copy', () => {
    const html = '<html><body><h2 class="heading">A Real Heading Here</h2><p class="tiny">Too short</p></body></html>';
    assert.equal(extractPageTypographyEvidence(html), null);
  });

  test('skips a short heading/paragraph (likely a label/eyebrow) in favor of a later, real one', () => {
    const html = '<html><body>'
      + '<h3 class="eyebrow">New</h3>'
      + '<h2 class="real-heading">A Proper Section Heading</h2>'
      + '<p class="real-body">A real, sufficiently long paragraph of body copy for this page.</p>'
      + '</body></html>';
    const evidence = extractPageTypographyEvidence(html);
    assert.equal(evidence.headingClass, 'real-heading');
  });
});

// Real incident, Chayce Properties (site 8864), fetched live 2026-09-18:
// /get-started/index.html?package=... styles its hero heading and lead
// paragraph via container-scoped descendant selectors in its own inline
// <style> block, with ZERO class on the tags themselves.
const GS_HTML = '<html><head><style>'
  + '.gs-hero h1{font-size:48px}.gs-hero h1 em{font-style:italic}.gs-hero p{color:#555;font-size:17px}'
  + '</style></head><body>'
  + '<div class="gs-hero"><h1>A guided <em>conversation,</em> at your own pace.</h1>'
  + '<p>Answer a few simple questions and we\'ll point you to the right support and next steps for your situation.</p></div>'
  + '</body></html>';
const GS_CSS = ".gs-hero h1{font-size:48px}.gs-hero h1 em{font-style:italic}.gs-hero p{color:#555;font-size:17px}";

describe('extractPageTypographyEvidence — bare-tag-via-container fallback (Chayce /get-started/ incident)', () => {
  test('with no css given, a class-less heading/paragraph still returns null — unchanged, backward-compatible default', () => {
    assert.equal(extractPageTypographyEvidence(GS_HTML), null);
  });

  test('with the real live css, finds tag-based evidence for a heading and paragraph that carry no class of their own', () => {
    const evidence = extractPageTypographyEvidence(GS_HTML, GS_CSS);
    assert.ok(evidence, 'must find usable evidence now that css is available to confirm it');
    assert.equal(evidence.headingClass, null);
    assert.equal(evidence.headingTag, 'h1');
    assert.equal(evidence.headingContainerClass, 'gs-hero');
    assert.equal(evidence.bodyClass, null);
    assert.equal(evidence.bodyTag, 'p');
    assert.equal(evidence.bodyContainerClass, 'gs-hero');
  });

  test('a selector whose real target is a DIFFERENT tag does not count as evidence — .gs-hero h1 em styles em, not h1', () => {
    // Isolate: css defines .gs-hero ONLY via the em-targeting rule, never a
    // real h1-targeting rule, so the ONLY honest answer is "no evidence".
    const emOnlyCss = ".gs-hero h1 em{font-style:italic}";
    const html = '<html><head><style>' + emOnlyCss + '</style></head><body>'
      + '<div class="gs-hero"><h1>A heading with <em>emphasis</em> inside, long enough to count.</h1>'
      + '<p class="gs-lead">A real classed paragraph, long enough to count as body copy here.</p></div>'
      + '</body></html>';
    assert.equal(extractPageTypographyEvidence(html, emOnlyCss), null, 'h1 must not be credited from a rule that really targets em');
  });

  test('a mixed page — bare tag-styled heading, but a real classed paragraph — resolves both slots independently', () => {
    const evidence = extractPageTypographyEvidence(GS_HTML.replace(
      '<p>Answer a few simple questions',
      '<p class="gs-lead">Answer a few simple questions',
    ), GS_CSS);
    assert.equal(evidence.headingTag, 'h1');
    assert.equal(evidence.headingContainerClass, 'gs-hero');
    assert.equal(evidence.bodyClass, 'gs-lead');
    assert.equal(evidence.bodyTag, null, 'a slot resolved via a literal class must not also carry tag evidence');
  });
});

describe('buildPageEvidenceComponentTemplate', () => {
  test('composes a real template using ONLY the classes found in the page evidence — nothing invented', () => {
    const evidence = { headingClass: 'faqp-question', bodyClass: 'faqp-answer', containerClass: 'faqp-section' };
    const template = buildPageEvidenceComponentTemplate('expand-content', evidence);
    assert.match(template.row, /faqp-question/);
    assert.match(template.row, /faqp-answer/);
    assert.match(template.wrapper, /faqp-section/);
    assert.doesNotMatch(template.wrapper + template.row, /home-|shared-/, 'must carry only this page\'s own real classes');
  });

  test('falls back to the body class for the wrapper when no container was found, rather than failing outright', () => {
    const evidence = { headingClass: 'h', bodyClass: 'b', containerClass: null };
    const template = buildPageEvidenceComponentTemplate('expand-content', evidence);
    assert.ok(template, 'a missing container must not block a derivation that otherwise has real heading/body evidence');
  });

  test('returns null for non-projectable action types and for missing evidence', () => {
    assert.equal(buildPageEvidenceComponentTemplate('meta-title', { headingClass: 'h', bodyClass: 'b' }), null);
    assert.equal(buildPageEvidenceComponentTemplate('expand-content', null), null);
    assert.equal(buildPageEvidenceComponentTemplate('expand-content', { headingClass: 'h' }), null);
  });

  describe('bare-tag-via-container evidence (Chayce /get-started/ incident)', () => {
    test('puts the real container class on the wrapper and NO class on the bare heading/body tags', () => {
      const evidence = { headingClass: null, headingTag: 'h1', headingContainerClass: 'gs-hero', bodyClass: null, bodyTag: 'p', bodyContainerClass: 'gs-hero', containerClass: null };
      const template = buildPageEvidenceComponentTemplate('expand-content', evidence);
      assert.match(template.wrapper, /class="gs-hero"/);
      assert.match(template.row, /<h1>\{\{HEADING\}\}<\/h1>/, 'the real h1 tag, no class attribute at all');
      assert.match(template.row, /<p>\{\{BODY\}\}<\/p>/, 'the real p tag, no class attribute at all');
      const check = validatePlaceholders('expand-content', template);
      assert.equal(check.ok, true, check.error);
    });

    test('a mixed slot (tag-based heading, classed body) renders each slot per its own evidence kind', () => {
      const evidence = { headingClass: null, headingTag: 'h1', headingContainerClass: 'gs-hero', bodyClass: 'gs-lead', bodyTag: null, bodyContainerClass: null, containerClass: null };
      const template = buildPageEvidenceComponentTemplate('expand-content', evidence);
      assert.match(template.row, /<h1>\{\{HEADING\}\}<\/h1>/);
      assert.match(template.row, /<div class="gs-lead">\{\{BODY\}\}<\/div>/);
      assert.match(template.wrapper, /class="gs-hero"/, 'the confirmed container class still grounds the wrapper');
    });

    test('only expand-content is supported for the bare-tag shape — faq gets a clean refusal, not a guess', () => {
      const evidence = { headingClass: null, headingTag: 'h1', headingContainerClass: 'gs-hero', bodyClass: null, bodyTag: 'p', bodyContainerClass: 'gs-hero' };
      assert.equal(buildPageEvidenceComponentTemplate('faq', evidence), null);
    });

    test('a slot with a tag but no confirmed container (should never happen from real extraction, but must not fabricate one) refuses', () => {
      const evidence = { headingClass: null, headingTag: 'h1', headingContainerClass: null, bodyClass: null, bodyTag: 'p', bodyContainerClass: 'gs-hero' };
      assert.equal(buildPageEvidenceComponentTemplate('expand-content', evidence), null);
    });
  });
});

describe('resolvePageComponentTemplate — page-scoped component templates (Chayce-shaped fixtures)', () => {
  // Real shape: chayceproperties.com has NO shared design system — every
  // page ships its own inline <style> block, and classes like home-h2/
  // home-section/body-copy are only ever DEFINED on the homepage. /faq/ and
  // /news/ each define their own, completely disjoint class vocabulary. This
  // is exactly the incident resolvePageComponentTemplate exists to fix: a
  // componentTemplates.expandContent entry captured from the homepage must
  // never ship those classes onto a page that never had them.
  const HOME_URL = 'https://chayce.example/';
  const FAQ_URL = 'https://chayce.example/faq/';
  const NEWS_URL = 'https://chayce.example/news/';

  const HOME_HTML = '<html><head><style>'
    + ".home-h2{font-family:'Playfair',serif;font-size:34px}.home-section{padding:80px 0}.body-copy{color:#555;font-size:16.5px}"
    + '</style></head><body>'
    + '<section class="home-section"><h2 class="home-h2">Welcome to Chayce Properties</h2>'
    + '<p class="body-copy">Real homepage body copy, long enough to count as prose for the extraction heuristic.</p></section>'
    + '</body></html>';

  const FAQ_HTML = '<html><head><style>'
    + '.faqp-section{padding:56px 0}.faqp-question{font-size:20px}.faqp-answer{color:#666;font-size:15px}'
    + '</style></head><body>'
    + '<section class="faqp-section"><h2 class="faqp-question">Frequently Asked Questions</h2>'
    + '<p class="faqp-answer">A real FAQ answer, long enough in length to count as this page\'s own body copy.</p></section>'
    + '</body></html>';

  const NEWS_HTML = '<html><head><style>'
    + '.news-section{padding:64px 0}.news-h3{font-size:24px}.news-body{color:#444;font-size:15px}'
    + '</style></head><body>'
    + '<div class="news-section"><h3 class="news-h3">Latest Chayce Properties News Update</h3>'
    + '<p class="news-body">A real news blurb, long enough to be picked up as this page\'s own body copy.</p></div>'
    + '</body></html>';

  const fetchPageFor = (map) => async (url) => map[url] ?? null;
  const noStylesheet = async () => { throw new Error('page-scoped inline-CSS sites have no linked stylesheet to fetch'); };

  const homeExpandContentTemplate = {
    wrapper: '<div class="home-section">\n{{ROWS}}\n</div>',
    row: '  <section>\n    <h2 class="home-h2">{{HEADING}}</h2>\n    <div class="body-copy">{{BODY}}</div>\n  </section>',
    verifiedAt: '2026-09-16T01:49:50.097Z', verifiedBy: 'freshness-check', verifiedRef: HOME_URL,
  };

  function chayceSite(extraSiteRoot = {}) {
    return {
      id: 8864,
      name: 'Chayceproperties',
      url_file_map: {
        pages: { '/': { file: 'src/index.njk' }, '/faq/': { file: 'src/faq.njk' }, '/news/': { file: 'src/news.njk' } },
        siteRoot: { componentTemplates: { expandContent: homeExpandContentTemplate }, ...extraSiteRoot },
      },
    };
  }
  const noopDeps = () => ({ saveConfig: async ({ urlFileMap }) => ({ id: 8864, url_file_map: urlFileMap }), recordAudit: async () => {} });

  test('a homepage-captured template is never silently applied to /faq/', async () => {
    const result = await resolvePageComponentTemplate(chayceSite(), 'expand-content', FAQ_URL, {
      fetchPage: fetchPageFor({ [FAQ_URL]: FAQ_HTML }), fetchStylesheet: noStylesheet, ...noopDeps(),
    });
    assert.equal(result.ok, true, 'a page with its own real design must not be treated as a failure');
    assert.notEqual(result.tier, PAGE_COMPONENT_TEMPLATE_TIER.SITE, 'must not silently reuse the homepage-captured template');
    assert.doesNotMatch(
      `${result.template.wrapper}${result.template.row}`,
      /home-h2|home-section|body-copy/,
      'the homepage-only classes must never ship onto /faq/',
    );
  });

  test('/faq/ ends up using its own, independently-verified design', async () => {
    const result = await resolvePageComponentTemplate(chayceSite(), 'expand-content', FAQ_URL, {
      fetchPage: fetchPageFor({ [FAQ_URL]: FAQ_HTML }), fetchStylesheet: noStylesheet, ...noopDeps(),
    });
    assert.equal(result.ok, true);
    assert.match(result.template.row, /faqp-question/);
    assert.match(result.template.row, /faqp-answer/);
    assert.equal(result.source, 'captured-from-page');
  });

  test('/news/ likewise uses its own design, not the homepage\'s or /faq/\'s', async () => {
    const result = await resolvePageComponentTemplate(chayceSite(), 'expand-content', NEWS_URL, {
      fetchPage: fetchPageFor({ [NEWS_URL]: NEWS_HTML }), fetchStylesheet: noStylesheet, ...noopDeps(),
    });
    assert.equal(result.ok, true);
    assert.match(result.template.row, /news-h3/);
    assert.match(result.template.row, /news-body/);
    assert.doesNotMatch(result.template.row, /faqp-|home-h2/);
  });

  test('a genuinely SHARED template (one global stylesheet, same classes everywhere) is reused, not re-captured per page', async () => {
    const sharedTemplate = {
      wrapper: '<div class="shared-section">\n{{ROWS}}\n</div>',
      row: '<section><h2 class="shared-h2">{{HEADING}}</h2><div class="shared-body">{{BODY}}</div></section>',
      verifiedAt: '2026-09-01T00:00:00.000Z', verifiedBy: 'freshness-check', verifiedRef: HOME_URL,
    };
    const sharedCss = '.shared-h2{font-size:32px}.shared-body{font-size:16px}.shared-section{padding:64px 0}';
    const linkedPageHtml = '<html><head><link rel="stylesheet" href="/main.css"></head><body><p>irrelevant</p></body></html>';
    const site = { id: 1, name: 'Shared Design Site', url_file_map: { siteRoot: { componentTemplates: { expandContent: sharedTemplate } } } };
    const result = await resolvePageComponentTemplate(site, 'expand-content', 'https://shared.example/some-other-page/', {
      fetchPage: async () => linkedPageHtml,
      fetchStylesheet: async () => sharedCss,
      ...noopDeps(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.tier, PAGE_COMPONENT_TEMPLATE_TIER.SITE, 'a genuinely shared template must be reused, not re-derived per page');
    assert.equal(result.source, 'existing');
    assert.deepEqual(result.template, sharedTemplate);
  });

  test('a stale template is automatically recaptured and the draft proceeds — never abandoned to human review for a page with its own valid design', async () => {
    const result = await resolvePageComponentTemplate(chayceSite(), 'expand-content', FAQ_URL, {
      fetchPage: fetchPageFor({ [FAQ_URL]: FAQ_HTML }), fetchStylesheet: noStylesheet, ...noopDeps(),
    });
    assert.equal(result.ok, true, 'must not fall through to an abandon/human-review outcome');
    assert.equal(result.justCaptured, true);
    assert.notEqual(result.reason, 'template-stale');
  });

  test('persists the freshly captured template so a later draft for the same page/file reuses it without re-deriving', async () => {
    let savedUrlFileMap = null;
    await resolvePageComponentTemplate(chayceSite(), 'expand-content', FAQ_URL, {
      fetchPage: fetchPageFor({ [FAQ_URL]: FAQ_HTML }),
      fetchStylesheet: noStylesheet,
      saveConfig: async ({ urlFileMap }) => { savedUrlFileMap = urlFileMap; return { id: 8864, url_file_map: urlFileMap }; },
      recordAudit: async () => {},
    });
    assert.ok(savedUrlFileMap.siteRoot.pageComponentTemplates.expandContent.byUrl[FAQ_URL], 'page-specific slot persisted');
    assert.ok(savedUrlFileMap.siteRoot.pageComponentTemplates.expandContent.byFile['src/faq.njk'], 'promoted to the page-type (file) slot too');

    const siteAfterCapture = chayceSite({ pageComponentTemplates: savedUrlFileMap.siteRoot.pageComponentTemplates });
    let fetchCount = 0;
    const second = await resolvePageComponentTemplate(siteAfterCapture, 'expand-content', FAQ_URL, {
      fetchPage: async (url) => { fetchCount += 1; return url === FAQ_URL ? FAQ_HTML : null; },
      fetchStylesheet: noStylesheet,
      ...noopDeps(),
    });
    assert.equal(second.ok, true);
    assert.equal(second.tier, PAGE_COMPONENT_TEMPLATE_TIER.PAGE);
    assert.equal(second.source, 'existing');
    assert.equal(fetchCount, 1, 'reuses the persisted template via an ordinary freshness check — no re-derivation fetch');
  });

  test('recapture succeeds end-to-end via the bare-tag-via-container fallback when the page has real evidence but no class on its heading/body', async () => {
    // Real shape (Chayce Properties /get-started/, fetched live 2026-09-18):
    // no class on <h1>/<p> at all, styled only through the page's own
    // .gs-hero h1 / .gs-hero p descendant rules — this is the exact page
    // shape resolvePageComponentTemplate previously refused with
    // "no-page-evidence" even though the page visibly has real, styled,
    // expandable content. `site` here has NO existing tier at any level,
    // so this exercises extraction -> build -> the REAL
    // verifyTemplateAgainstLiveSite (not a mocked bypass) end to end.
    const GS_URL = 'https://chayce.example/get-started/index.html?package=Silver';
    const GS_PAGE_HTML = '<html><head><style>'
      + '.gs-hero h1{font-family:\'Playfair\',serif;font-size:48px}.gs-hero h1 em{font-style:italic}'
      + '.gs-hero p{color:#555;font-size:17px}'
      + '</style></head><body>'
      + '<div class="gs-hero"><h1>A guided <em>conversation,</em> at your own pace.</h1>'
      + '<p>Answer a few simple questions and we\'ll point you to the right support and next steps for your situation.</p></div>'
      + '</body></html>';
    const site = { id: 8864, name: 'Chayceproperties', url_file_map: { pages: {}, siteRoot: {} } };
    const result = await resolvePageComponentTemplate(site, 'expand-content', GS_URL, {
      fetchPage: fetchPageFor({ [GS_URL]: GS_PAGE_HTML }), fetchStylesheet: noStylesheet, ...noopDeps(),
    });
    assert.equal(result.ok, true, result.error);
    assert.notEqual(result.reason, 'no-page-evidence');
    assert.match(result.template.wrapper, /class="gs-hero"/);
    assert.match(result.template.row, /<h1>\{\{HEADING\}\}<\/h1>/);
    assert.match(result.template.row, /<p>\{\{BODY\}\}<\/p>/);
    // Confirms this real path is NOT rejected via verifyTemplateAgainstLiveSite's
    // 'no-design-claims' branch — the derived template is not fully classless
    // (the wrapper carries the real, confirmed 'gs-hero' class), so
    // freshness.checkedClasses is non-empty and stamping proceeds normally.
    assert.equal(result.template.verifiedBy, 'freshness-check');
    assert.ok(result.template.verifiedAt);
  });

  test('when recapture genuinely cannot succeed (the page is reachable but has no real styled heading/body), it fails safely instead of shipping broken classes', async () => {
    // A real, fetchable page with its OWN CSS (so the SITE-tier freshness
    // check can positively confirm staleness rather than merely failing to
    // check at all) that simply has no classed heading/paragraph for the
    // recapture step to derive anything real from.
    const bareHtml = '<html><head><style>.unrelated{color:red}</style></head><body><h2>Untitled</h2><p>short</p></body></html>';
    const result = await resolvePageComponentTemplate(chayceSite(), 'expand-content', FAQ_URL, {
      fetchPage: fetchPageFor({ [FAQ_URL]: bareHtml }), fetchStylesheet: noStylesheet, ...noopDeps(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-page-evidence');
    assert.ok(result.error);
  });

  test('when there is no existing template at all and the target page is genuinely unreachable, fails safely rather than guessing', async () => {
    // No componentTemplates configured for this action type at all — the
    // tier loop has nothing to check (and therefore never even calls
    // fetchPage), so this exercises the recapture step's OWN fetch failing
    // on the very first attempt, distinct from a tier check merely being
    // unable to verify an existing template (which fails open by design).
    const site = { id: 8864, name: 'Chayceproperties', url_file_map: { pages: chayceSite().url_file_map.pages, siteRoot: {} } };
    const result = await resolvePageComponentTemplate(site, 'expand-content', FAQ_URL, {
      fetchPage: async () => null, fetchStylesheet: noStylesheet, ...noopDeps(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unreachable');
  });

  test('a componentTemplateKey with no concept (e.g. a page-scoped action type with no COMPONENT_TEMPLATE_KEY entry) is a clean passthrough', async () => {
    const result = await resolvePageComponentTemplate(chayceSite(), 'meta-title', FAQ_URL, noopDeps());
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'no-concept');
  });
});

// A page whose body actually contains one real, filled-in example of
// wrapper/row — realistic evidence a structural check should find, the same
// way a real captured template's source page always does. Built once so
// every "this template genuinely matches the live page" test below shares
// identical, obviously-consistent fixtures instead of each writing its own
// slightly-different page body.
function pageContaining(wrapper, row) {
  const filledRow = row.replace('{{QUESTION}}', 'What is this?').replace('{{ANSWER}}', 'An answer.');
  const body = wrapper.replace('{{ROWS}}', filledRow);
  return `<html><head><link rel="stylesheet" href="/assets/main.css"></head><body>${body}</body></html>`;
}

describe('checkTemplateStructuralMatch', () => {
  const wrapper = '<section class="py-12 bg-gray-50"><div x-data="{ activeIndex: null }">{{ROWS}}</div></section>';
  const row = '<div class="py-5"><button @click="activeIndex = 1"><span>{{QUESTION}}</span></button><p>{{ANSWER}}</p></div>';

  test('matches when the real page body contains the template\'s shape, placeholders filled with real content', async () => {
    const html = pageContaining(wrapper, row);
    const result = await checkTemplateStructuralMatch({ pageUrl: 'https://example.com/', templateEntry: { wrapper, row }, html });
    assert.equal(result.ok, true);
    assert.equal(result.structurallyStale, false);
    assert.deepEqual(result.missingStructure, []);
  });

  // The actual 2026-09-10 incident, reproduced directly: a captured flat <dl>
  // template whose individual classes are all perfectly real and live
  // (checkTemplateFreshness would pass it every time), spliced against a
  // page whose real component is a completely different shape (an Alpine
  // accordion with a <button>/x-data, not a <dl>). Every class the flat
  // template names may well exist somewhere on this same page's own CSS —
  // structural match doesn't care about CSS at all, only about whether this
  // markup SHAPE is literally present.
  test('does not match a structurally different component even when its classes would be live (the 2026-09-10 incident)', async () => {
    const wrongTemplate = {
      wrapper: '<dl class="py-12 md:py-20">{{ROWS}}</dl>',
      row: '<dt class="text-2xl md:text-3xl font-normal text-gray-900">{{QUESTION}}</dt><dd class="text-lg text-gray-600">{{ANSWER}}</dd>',
    };
    // The real page has the real accordion, not a <dl> anywhere.
    const html = pageContaining(wrapper, row);
    const result = await checkTemplateStructuralMatch({ pageUrl: 'https://example.com/', templateEntry: wrongTemplate, html });
    assert.equal(result.ok, true);
    assert.equal(result.structurallyStale, true);
    assert.deepEqual(result.missingStructure, ['wrapper', 'row']);
  });

  test('tolerates indentation/whitespace differences between the captured copy and the live page', async () => {
    const spacedWrapper = wrapper.replace('><div', '>\n  <div').replace('>{{ROWS}}', '>\n    {{ROWS}}');
    const html = pageContaining(spacedWrapper, row);
    // Checked against the ORIGINAL (unspaced) captured template — real repo
    // formatting drift, not a shape change, must not be flagged.
    const result = await checkTemplateStructuralMatch({ pageUrl: 'https://example.com/', templateEntry: { wrapper, row }, html });
    assert.equal(result.structurallyStale, false);
  });

  test('a template with no wrapper has nothing to check, not a false failure', async () => {
    const result = await checkTemplateStructuralMatch({ pageUrl: 'https://example.com/', templateEntry: {}, html: '<html></html>' });
    assert.equal(result.ok, true);
    assert.equal(result.structurallyStale, false);
  });

  test('an unfetchable page fails as unreachable, never as a silent pass', async () => {
    const result = await checkTemplateStructuralMatch({
      pageUrl: 'https://example.com/', templateEntry: { wrapper, row }, fetchPage: async () => null,
    });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});

describe('verifyTemplateAgainstLiveSite', () => {
  const wrapper = '<section class="py-12"><div class="divide-y divide-gray-200">{{ROWS}}</div></section>';
  const row = '<div class="py-5"><span>{{QUESTION}}</span><p>{{ANSWER}}</p></div>';
  const liveCss = '.py-12{a}.divide-y>:not([hidden]){a}.divide-gray-200{a}.py-5{a}';
  // Body actually contains the shape (see checkTemplateStructuralMatch above)
  // — every "should verify cleanly" test below needs this now that structure
  // is checked too, not just CSS class existence.
  const html = pageContaining(wrapper, row);

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

  // The actual regression this whole feature exists to close: a template
  // whose classes are all live (checkTemplateFreshness alone would pass it)
  // but whose structure is a completely different, unrelated component —
  // must be rejected, not stamped as the strongest verification tier.
  test('a template with live classes but the wrong structure is rejected as structural-mismatch, never stamped', async () => {
    const wrongShape = {
      wrapper: '<dl class="py-12">{{ROWS}}</dl>',
      row: '<dt class="divide-y">{{QUESTION}}</dt><dd class="divide-gray-200 py-5">{{ANSWER}}</dd>',
    };
    // Every class wrongShape uses is real and live in liveCss, so a
    // class-existence-only check would pass this — the live page's real
    // component is the <section>/divide-y accordion above, not a <dl>.
    const result = await verifyTemplateAgainstLiveSite('faq', wrongShape, {
      pageUrl: 'https://zunkireelabs.com', fetchPage: async () => html, fetchStylesheet: async () => liveCss,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'structural-mismatch');
    assert.ok(result.missingStructure.length > 0);
  });

  // Same-name, different meaning: neither checkTemplateFreshness (existence
  // only) nor checkTemplateStructuralMatch (same markup shape) can see a
  // class whose real declaration changed behind an unchanged name.
  test('first pass: no prior baseline, nothing to compare — passes and captures one', async () => {
    const result = await verifyTemplateAgainstLiveSite('faq', { wrapper, row }, {
      pageUrl: 'https://zunkireelabs.com', fetchPage: async () => html, fetchStylesheet: async () => liveCss,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.stamped.verifiedClassRules, { 'py-12': 'a', 'divide-y': 'a', 'divide-gray-200': 'a', 'py-5': 'a' });
  });

  test('re-verification: a class whose real CSS declaration changed is rejected as class-rule-drift, stamp not refreshed', async () => {
    const priorStamp = { wrapper, row, verifiedClassRules: { 'py-12': 'a', 'divide-y': 'a', 'divide-gray-200': 'a', 'py-5': 'a' } };
    // Same class names, same markup shape (liveCss still defines every one
    // of them) — but .py-5's real rule body is now different text.
    const rebrandedCss = liveCss.replace('.py-5{a}', '.py-5{b}');
    const result = await verifyTemplateAgainstLiveSite('faq', priorStamp, {
      pageUrl: 'https://zunkireelabs.com', fetchPage: async () => html, fetchStylesheet: async () => rebrandedCss,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'class-rule-drift');
    assert.equal(result.drifted.length, 1);
    assert.equal(result.drifted[0].cls, 'py-5');
    assert.equal(result.stamped, undefined, 'a rejected re-verification must not carry a fresh stamp');
  });

  test('re-verification: every prior rule body still matches — passes, no drift', async () => {
    const priorStamp = { wrapper, row, verifiedClassRules: { 'py-12': 'a', 'divide-y': 'a', 'divide-gray-200': 'a', 'py-5': 'a' } };
    const result = await verifyTemplateAgainstLiveSite('faq', priorStamp, {
      pageUrl: 'https://zunkireelabs.com', fetchPage: async () => html, fetchStylesheet: async () => liveCss,
    });
    assert.equal(result.ok, true);
  });
});

describe('captureClassRules / checkClassRuleDrift', () => {
  test('captureClassRules skips a class with no real rule body, includes every class that has one', () => {
    const rules = captureClassRules(['py-5', 'not-a-real-class'], '.py-5{padding:1.25rem 0}');
    assert.deepEqual(rules, { 'py-5': 'padding:1.25rem 0' });
  });

  test('captureClassRules normalizes whitespace so a cosmetic reformat is not a drift', () => {
    const rules = captureClassRules(['py-5'], '.py-5 {\n  padding: 1.25rem   0;\n}');
    assert.equal(rules['py-5'], 'padding: 1.25rem 0;');
  });

  test('checkClassRuleDrift only compares classes present in both snapshots', () => {
    const before = { 'py-5': 'padding:1.25rem 0', 'gone-now': 'x' };
    const { drifted } = checkClassRuleDrift(before, '.py-5{padding:1.25rem 0}');
    assert.equal(drifted.length, 0, 'gone-now has no live rule body at all — that is checkTemplateFreshness missingClasses\' job, not this one\'s');
  });

  test('checkClassRuleDrift flags a real value change', () => {
    const before = { 'py-5': 'padding:1.25rem 0' };
    const { drifted } = checkClassRuleDrift(before, '.py-5{padding:0.5rem 0}');
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0].before, 'padding:1.25rem 0');
    assert.equal(drifted[0].after, 'padding:0.5rem 0');
  });

  test('an empty/missing baseline compares nothing — never a false drift on a first pass', () => {
    assert.deepEqual(checkClassRuleDrift(null, '.py-5{padding:1.25rem 0}').drifted, []);
    assert.deepEqual(checkClassRuleDrift({}, '.py-5{padding:1.25rem 0}').drifted, []);
  });
});

// Minimal profile.pages[].sections[].textHierarchy[] fixture — the shape
// segment.js's segmentPage actually produces (see segment.test.js), reduced
// to only what observedClassesByRole/checkTypographyRole read.
function pageWith(sections) {
  return { url: 'https://example.com/', pageType: 'homepage', sections };
}
function item(role, classes) {
  return { role, text: null, tag: 'p', style: null, classes };
}

describe('observedClassesByRole / checkTypographyRole / verifyProfileRoles — role verification', () => {
  test('observedClassesByRole groups normalized class strings by the role they were seen playing', () => {
    const profile = {
      pages: [pageWith([
        { role: 'hero', textHierarchy: [item('body', 'text-lg   text-gray-700')] },
        { role: 'footer', textHierarchy: [item('body', 'text-lg text-gray-700'), item('cta', 'btn btn-primary')] },
      ])],
    };
    const observed = observedClassesByRole(profile);
    // Same string, different whitespace, across two different sections —
    // normalized to the one entry, not two.
    assert.equal(observed.get('body').size, 1);
    assert.equal(observed.get('body').has('text-lg text-gray-700'), true);
    assert.equal(observed.get('cta').has('btn btn-primary'), true);
  });

  // The incident this whole check exists to catch: real classes, real
  // sections, but typography.body names the class this site actually uses
  // for its eyebrow (captured under textHierarchy role 'cta' here, since
  // segment.js has no dedicated 'eyebrow' role — any role other than 'body'
  // demonstrates the same defect: the class was never observed AS body copy).
  const EYEBROW_AS_BODY_PROFILE = {
    typography: { body: 'text-xs uppercase tracking-widest text-gray-500', heading: { item: 'text-2xl font-bold' } },
    pages: [pageWith([
      { role: 'hero', textHierarchy: [
        item('cta', 'text-xs uppercase tracking-widest text-gray-500'), // the real eyebrow
        item('body', 'text-base leading-relaxed text-gray-700'),        // the real body copy
        item('heading', 'text-2xl font-bold'),
      ] },
    ])],
  };

  test('checkTypographyRole names the real role a misassigned class belongs to', () => {
    const result = checkTypographyRole(EYEBROW_AS_BODY_PROFILE, { field: 'typography.body', roles: ['body'], get: (p) => p.typography.body });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'role-mismatch');
    assert.equal(result.observedAs, 'cta');
    assert.match(result.error, /typography\.body uses classes this site only ever uses for its cta/);
  });

  test('verifyProfileRoles independently rediscovers the eyebrow-as-body-copy incident', () => {
    const result = verifyProfileRoles(EYEBROW_AS_BODY_PROFILE);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'role-mismatch');
    assert.equal(result.field, 'typography.body');
  });

  test('a correctly-assigned profile passes cleanly', () => {
    const result = verifyProfileRoles({
      typography: { body: 'text-base leading-relaxed text-gray-700', heading: { item: 'text-2xl font-bold' }, link: 'text-blue-600 underline' },
      pages: [pageWith([
        { role: 'hero', textHierarchy: [
          item('body', 'text-base leading-relaxed text-gray-700'),
          item('heading', 'text-2xl font-bold'),
          item('link', 'text-blue-600 underline'),
        ] },
      ])],
    });
    assert.deepEqual(result, { ok: true });
  });

  test('a class never observed in ANY role is class-unobserved, not role-mismatch — weaker evidence, does not block', () => {
    // The capture DOES record body copy here (just a different class than the
    // profile names) — which is what makes this the thin-sample case rather
    // than the no-evidence-at-all case covered separately below.
    const thinSample = {
      typography: { body: 'text-lg italic' },
      pages: [pageWith([{ role: 'hero', textHierarchy: [item('cta', 'btn'), item('body', 'text-base text-gray-700')] }])],
    };
    const result = checkTypographyRole(
      thinSample,
      { field: 'typography.body', roles: ['body'], get: (p) => p.typography.body },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'class-unobserved');
    assert.equal(result.observedAs, null);
    // verifyProfileRoles only blocks on a CONFIRMED mismatch — this weaker
    // case must pass through as ok, so a thin 8-page sample doesn't
    // permanently flag a real, correctly-assigned site.
    assert.equal(verifyProfileRoles(thinSample).ok, true);
  });

  // The live defect this check had against EVERY site, found on 2026-09-01
  // while auditing why 54/54 recorded verdicts failed. capture.js emits only
  // four roles — heading, body, cta, subheading — so typography.link's
  // accepted role set (['link']) matches nothing on any site, ever. And
  // because an inline link's classes are genuinely captured under 'cta', the
  // field fell through to the `actual` branch and was reported as a
  // CONFIRMED role-mismatch: the one reason that blocks. Enabling
  // DESIGN_INTEGRITY_ENFORCE as the rollout plan intended would therefore
  // have blocked every visible-content draft for every tenant, permanently,
  // on a defect none of them have.
  test('a field whose accepted role the capture never emits is role-unobserved, not a confirmed mismatch', () => {
    // Site 1's real shape: a plain inline-link style, captured under 'cta'
    // because that is the only anchor-ish role capture.js has.
    const profile = {
      typography: { body: 'text-gray-600 leading-relaxed', link: 'text-zunkiree-600 hover:underline' },
      pages: [pageWith([
        { role: 'hero', textHierarchy: [
          item('cta', 'text-zunkiree-600 hover:underline'),
          item('body', 'text-gray-600 leading-relaxed'),
        ] },
      ])],
    };
    const result = checkTypographyRole(profile, { field: 'typography.link', roles: ['link'], get: (p) => p.typography.link });

    assert.equal(result.ok, false, 'still reported — never silently dropped');
    assert.equal(result.reason, 'role-unobserved');
    assert.match(result.error, /no link elements on any page/);

    // The property that actually matters: it must not block. A field with no
    // evidence base cannot honestly CONFIRM anything.
    assert.equal(verifyProfileRoles(profile).ok, true);
  });

  // The other half of the same guarantee: relaxing the unverifiable field
  // must not blunt the check where evidence DOES exist, or the incident this
  // gate was built for walks straight through it.
  test('a role the capture DOES emit still confirms and blocks', () => {
    assert.equal(verifyProfileRoles(EYEBROW_AS_BODY_PROFILE).reason, 'role-mismatch');
  });

  test('a null typography field is an honest abstention, never a failure', () => {
    const result = checkTypographyRole({ typography: {}, pages: [] }, { field: 'typography.link', roles: ['link'], get: (p) => p.typography.link });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'not-set');
  });

  // typography.heading.item accepts BOTH 'heading' and 'subheading' as
  // matching evidence — segment.js only distinguishes h1-vs-not, with no
  // section-vs-item concept of its own, the same generosity
  // correctHeadingTypography's own headingSamplesByLevel already extends.
  test('typography.heading.item matches evidence recorded as either heading or subheading', () => {
    const result = checkTypographyRole(
      { typography: { heading: { item: 'text-xl font-semibold' } }, pages: [pageWith([{ role: 'content', textHierarchy: [item('subheading', 'text-xl font-semibold')] }])] },
      { field: 'typography.heading.item', roles: ['heading', 'subheading'], get: (p) => p.typography.heading.item },
    );
    assert.equal(result.ok, true);
  });

  // The gap this closes: expand-content's own heading slot (projectExpandContent
  // in design-profile.js) uses typography.heading.section first, falling back
  // to heading.item — but only heading.item was ever role-checked, so a
  // section-heading defect specific to expand-content had no coverage at all.
  test('typography.heading.section is checked too, not only heading.item', () => {
    const result = verifyProfileRoles({
      typography: { heading: { section: 'text-xs uppercase tracking-widest text-gray-500' } }, // really the eyebrow
      pages: [pageWith([{ role: 'hero', textHierarchy: [
        item('cta', 'text-xs uppercase tracking-widest text-gray-500'),
        item('heading', 'text-4xl font-bold'), // the site's real section heading — the evidence base this check needs
      ] }])],
    });
    assert.equal(result.ok, false);
    assert.equal(result.field, 'typography.heading.section');
    assert.equal(result.observedAs, 'cta');
  });

  test('a link style secretly identical to a button is caught the same way, keyed to typography.link', () => {
    const profile = {
      typography: { link: 'inline-block bg-blue-600 text-white px-6 py-3 rounded-full' }, // really the CTA button's classes
      pages: [pageWith([
        { role: 'hero', textHierarchy: [
          item('cta', 'inline-block bg-blue-600 text-white px-6 py-3 rounded-full'),
          item('link', 'text-blue-600 underline'), // the site's real inline link
        ] },
      ])],
    };
    const result = verifyProfileRoles(profile);
    assert.equal(result.ok, false);
    assert.equal(result.field, 'typography.link');
    assert.equal(result.observedAs, 'cta');
  });
});

// checkDesignIntegrityGate replaces designReviewState as the actual
// ship-time authorization check (see backend.js/frontend.js's apply paths,
// and routes/auto-remediation-toggle.test.js for the removal of the human
// sign-off precondition that used to live in validateAutoRemediationRequest).
describe('checkDesignIntegrityGate', () => {
  const originalEnforce = process.env.DESIGN_INTEGRITY_ENFORCE;
  beforeEach(() => {
    recordedVerdicts.length = 0;
    delete process.env.DESIGN_INTEGRITY_ENFORCE;
  });
  afterEach(() => {
    if (originalEnforce === undefined) delete process.env.DESIGN_INTEGRITY_ENFORCE;
    else process.env.DESIGN_INTEGRITY_ENFORCE = originalEnforce;
  });

  const roleMismatchProfile = {
    version: DESIGN_PROFILE_VERSION,
    typography: { body: 'text-xs uppercase tracking-widest text-gray-500', heading: { item: 'text-2xl font-bold' } }, // body is really the eyebrow
    layout: { container: 'max-w-7xl mx-auto' },
    // The real body copy is captured too — without an observed 'body' role
    // there would be no evidence base, and the finding would correctly
    // downgrade to the non-blocking 'role-unobserved' (see
    // checkTypographyRole). This fixture is specifically the CONFIRMED case.
    pages: [pageWith([{ role: 'hero', textHierarchy: [
      item('cta', 'text-xs uppercase tracking-widest text-gray-500'),
      item('body', 'text-base leading-relaxed'),
    ] }])],
  };
  const cleanProfile = {
    version: DESIGN_PROFILE_VERSION,
    typography: { body: 'text-base leading-relaxed', heading: { item: 'text-2xl font-bold' } },
    layout: { container: 'max-w-7xl mx-auto' },
    pages: [pageWith([{ role: 'content', textHierarchy: [item('body', 'text-base leading-relaxed')] }])],
  };

  test('a site with no usable design profile passes trivially — nothing to verify', async () => {
    const gate = await checkDesignIntegrityGate({ id: 1, url_file_map: { siteRoot: {} } }, { actionType: 'faq' });
    assert.equal(gate.ok, true);
    assert.equal(gate.reason, 'no-profile');
    assert.equal(recordedVerdicts.length, 0, 'nothing to log when there is no profile to check');
  });

  test('LOG-ONLY mode (the default): a confirmed role-mismatch is recorded but never blocks shipping', async () => {
    const site = { id: 2, url_file_map: { siteRoot: { designProfile: roleMismatchProfile } } };
    const gate = await checkDesignIntegrityGate(site, { actionType: 'faq', findingId: 'faq:1' });

    assert.equal(gate.ok, true, 'log-only mode never blocks, even on a real defect');
    assert.equal(gate.reason, 'log-only');
    assert.equal(recordedVerdicts.length, 1);
    assert.equal(recordedVerdicts[0].siteId, 2);
    assert.equal(recordedVerdicts[0].findingId, 'faq:1');
    assert.equal(recordedVerdicts[0].actionType, 'faq');
    assert.equal(recordedVerdicts[0].enforced, false);
    assert.equal(recordedVerdicts[0].verdict.ok, false, 'the real verdict is still recorded for later false-positive review, even though it did not block');
    assert.equal(recordedVerdicts[0].verdict.field, 'typography.body');
  });

  test('LOG-ONLY mode: a clean profile passes and is recorded as passing', async () => {
    const site = { id: 3, url_file_map: { siteRoot: { designProfile: cleanProfile } } };
    const gate = await checkDesignIntegrityGate(site, { actionType: 'qa-content' });
    assert.equal(gate.ok, true);
    assert.equal(recordedVerdicts[0].verdict.ok, true);
  });

  test('ENFORCE mode: a confirmed role-mismatch blocks that draft, with the same evidence a human reviewer would have seen', async () => {
    process.env.DESIGN_INTEGRITY_ENFORCE = 'true';
    const site = { id: 4, url_file_map: { siteRoot: { designProfile: roleMismatchProfile } } };
    const gate = await checkDesignIntegrityGate(site, { actionType: 'faq', findingId: 'faq:2' });

    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'role-mismatch');
    assert.equal(gate.field, 'typography.body');
    assert.equal(gate.observedAs, 'cta');
    assert.match(gate.error, /uses classes this site only ever uses for its cta/);
    assert.equal(recordedVerdicts[0].enforced, true);
  });

  test('ENFORCE mode: a clean profile still ships normally', async () => {
    process.env.DESIGN_INTEGRITY_ENFORCE = 'true';
    const site = { id: 5, url_file_map: { siteRoot: { designProfile: cleanProfile } } };
    const gate = await checkDesignIntegrityGate(site, { actionType: 'qa-content' });
    assert.equal(gate.ok, true);
  });
});

describe('designReviewFingerprint / designReviewState — sign-off is pinned to the exact profile reviewed', () => {
  const USABLE = {
    version: DESIGN_PROFILE_VERSION,
    typography: { body: 'text-base leading-relaxed', heading: { item: 'text-2xl font-bold' }, link: 'text-blue-600 underline' },
    layout: { container: 'max-w-7xl mx-auto' },
    components: {},
    spacing: {},
    pages: [],
  };

  test('is deterministic — the same profile always fingerprints the same', () => {
    assert.equal(designReviewFingerprint(USABLE), designReviewFingerprint(structuredClone(USABLE)));
  });

  // The gate this exists to prevent: profile.evidence/site.pagesAnalyzed
  // change on every weekly rescan without a single thing that ships actually
  // changing. Fingerprinting those would invalidate a valid, already-reviewed
  // sign-off on pure noise — training staff to click approve without reading.
  test('metadata that never reaches a template (evidence, pagesAnalyzed) does not change the fingerprint', () => {
    const withMetadata = { ...USABLE, evidence: { notes: 'voice is playful', pagesAnalyzed: ['https://x.com/new-page'] }, site: { pagesAnalyzed: ['https://x.com/'] } };
    assert.equal(designReviewFingerprint(USABLE), designReviewFingerprint(withMetadata));
  });

  test('a real design change (a rescan altering typography.body) changes the fingerprint', () => {
    const changed = { ...USABLE, typography: { ...USABLE.typography, body: 'text-lg leading-loose' } };
    assert.notEqual(designReviewFingerprint(USABLE), designReviewFingerprint(changed));
  });

  test('null profile fingerprints to null, never throws', () => {
    assert.equal(designReviewFingerprint(null), null);
  });

  test('a site that was never reviewed is unreviewed, not stale', () => {
    const result = designReviewState({ url_file_map: { siteRoot: { designProfile: USABLE } } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unreviewed');
  });

  test('a site whose stored fingerprint matches its current profile passes', () => {
    const site = {
      design_review_at: '2026-08-01T00:00:00Z',
      design_review_fingerprint: designReviewFingerprint(USABLE),
      url_file_map: { siteRoot: { designProfile: USABLE } },
    };
    assert.deepEqual(designReviewState(site), { ok: true });
  });

  // The scenario this whole distinction exists for: the weekly rescan
  // (cron.js) overwrites designProfile with a freshly re-derived one after a
  // real redesign, without touching design_review_at/design_review_fingerprint
  // — a six-week-old approval must not silently keep authorizing templates
  // derived from a design nobody has actually looked at since.
  test('a site whose design was re-derived after review is stale, not silently still approved', () => {
    const changedProfile = { ...USABLE, typography: { ...USABLE.typography, body: 'text-lg leading-loose' } };
    const site = {
      design_review_at: '2026-08-01T00:00:00Z',
      design_review_fingerprint: designReviewFingerprint(USABLE), // approved BEFORE the rescan
      url_file_map: { siteRoot: { designProfile: changedProfile } }, // rescan already overwrote it
    };
    const result = designReviewState(site);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale');
  });
});

describe('withDesignContext — the shared design-intelligence layer\'s system-prompt grounding', () => {
  const USABLE_PROFILE = {
    version: DESIGN_PROFILE_VERSION,
    styling: 'tailwind',
    typography: { body: 'text-base', heading: { item: 'text-2xl font-bold' } },
    layout: { container: 'max-w-7xl mx-auto' },
    pageTypePatterns: { homepage: { sectionOrder: ['header', 'hero', 'footer'], notes: 'short, punchy hero copy' } },
    evidence: { notes: 'Voice is direct and informal.' },
  };
  const siteWith = (profile) => ({ id: 1, url_file_map: { siteRoot: { designProfile: profile } } });

  test('a generatorId outside the website-facing set is left completely untouched — never even fetches the site', async () => {
    let touched = false;
    const out = await withDesignContext('SYSTEM', 'meta-title', 1, { fetchSite: async () => { touched = true; return siteWith(USABLE_PROFILE); } });
    assert.equal(out, 'SYSTEM');
    assert.equal(touched, false);
  });

  test('no generatorId or no siteId is a no-op', async () => {
    assert.equal(await withDesignContext('SYSTEM', null, 1), 'SYSTEM');
    assert.equal(await withDesignContext('SYSTEM', 'faq', null), 'SYSTEM');
  });

  test('a website-facing generatorId with no usable profile yet is unchanged — never blocks generation', async () => {
    const out = await withDesignContext('SYSTEM', 'faq', 1, { fetchSite: async () => ({ id: 1, url_file_map: {} }) });
    assert.equal(out, 'SYSTEM');
  });

  test('a site-fetch failure fails open, unchanged, never throws', async () => {
    const out = await withDesignContext('SYSTEM', 'faq', 1, { fetchSite: async () => { throw new Error('db down'); } });
    assert.equal(out, 'SYSTEM');
  });

  test('a usable profile appends real design/voice grounding for a website-facing generator', async () => {
    const out = await withDesignContext('SYSTEM', 'translation', 1, { fetchSite: async () => siteWith(USABLE_PROFILE) });
    assert.match(out, /^SYSTEM/);
    assert.match(out, /tailwind/);
    assert.match(out, /short, punchy hero copy/);
    assert.match(out, /Voice is direct and informal\./);
  });

  test('every action type frontend.js/backend.js actually route as visible content is covered', () => {
    for (const id of ['faq', 'qa-content', 'expand-content', 'internal-links', 'direct-answer', 'alt-text', 'broken-link-fix', 'redirect-fix', 'translation', 'blog-outline', 'landing-page', 'cookie-policy', 'privacy-policy', 'terms-of-service']) {
      assert.ok(DESIGN_CONTEXT_GENERATOR_IDS.has(id), `${id} should get design/voice grounding`);
    }
  });

  test('purely technical action types are excluded', () => {
    for (const id of ['meta-title', 'schema', 'canonical', 'sitemap', 'robots-fix', 'security-headers', 'open-graph', 'html-lang', 'viewport', 'llms-txt', 'analytics-install', 'duplicate-id-fix', 'breadcrumbs', 'schema-repair']) {
      assert.ok(!DESIGN_CONTEXT_GENERATOR_IDS.has(id), `${id} should NOT get design/voice grounding`);
    }
  });
});

// Regression: on 2026-08-31 all five of zunkireelabs.com's component templates
// carried `verifiedBy: design-agent` while rendering every generated paragraph
// in the site's eyebrow style. Every class in them was real and defined —
// existence checks alone could never have caught it.
describe('bodySlotLooksLikeLabel', () => {
  const CSS = [
    '.text-xs{font-size:0.75rem;line-height:1rem}',
    '.uppercase{text-transform:uppercase}',
    '.tracking-widest{letter-spacing:0.1em}',
    '.text-zunkiree-600{color:#eb1600}',
    '.text-gray-600{color:#4b5563}',
    '.leading-relaxed{line-height:1.625}',
  ].join('');

  test('rejects the real template that shipped — a label class on the body slot', () => {
    const reason = bodySlotLooksLikeLabel('expand-content', {
      wrapper: '<div class="py-12">\n{{ROWS}}\n</div>',
      row: '  <section>\n    <h2 class="text-4xl">{{HEADING}}</h2>\n    <div class="text-xs uppercase tracking-widest text-zunkiree-600">{{BODY}}</div>\n  </section>',
    }, CSS);
    assert.ok(reason, 'must not verify');
    assert.match(reason, /uppercase/);
    assert.match(reason, /\{\{BODY\}\}/);
  });

  test('accepts a body slot styled as real prose', () => {
    const reason = bodySlotLooksLikeLabel('expand-content', {
      wrapper: '<div class="py-12">\n{{ROWS}}\n</div>',
      row: '  <section>\n    <h2 class="text-4xl">{{HEADING}}</h2>\n    <div class="text-gray-600 leading-relaxed">{{BODY}}</div>\n  </section>',
    }, CSS);
    assert.equal(reason, null);
  });

  test('an uppercase HEADING is fine — only the prose slot is judged', () => {
    const reason = bodySlotLooksLikeLabel('faq', {
      wrapper: '<dl>\n{{ROWS}}\n</dl>',
      row: '  <dt class="uppercase tracking-widest">{{QUESTION}}</dt>\n  <dd class="text-gray-600">{{ANSWER}}</dd>',
    }, CSS);
    assert.equal(reason, null);
  });

  test('internal-links is exempt — a link list may be styled in caps deliberately', () => {
    const reason = bodySlotLooksLikeLabel('internal-links', {
      wrapper: '<ul>\n{{ROWS}}\n</ul>',
      row: '  <li><a href="{{URL}}" class="text-xs uppercase">{{ANCHOR_TEXT}}</a></li>',
    }, CSS);
    assert.equal(reason, null);
  });

  test('no CSS and no classes both mean "cannot tell", never "failed"', () => {
    const template = { wrapper: '<dl>\n{{ROWS}}\n</dl>', row: '<dt>{{QUESTION}}</dt><dd>{{ANSWER}}</dd>' };
    assert.equal(bodySlotLooksLikeLabel('faq', template, ''), null);
    assert.equal(bodySlotLooksLikeLabel('faq', template, CSS), null);
  });

  test('a sub-14px body slot is a caption even without uppercase', () => {
    const reason = bodySlotLooksLikeLabel('content-wrapper', {
      wrapper: '<div class="text-xs">\n{{BODY}}\n</div>',
    }, CSS);
    assert.ok(reason);
    assert.match(reason, /14px/);
  });
});
