import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrCreateCanonicalPageTemplate, pageTemplateGuidanceText, PAGE_TEMPLATE_TYPES_FOR_GENERATOR, PAGE_TEMPLATE_VERSION } from './page-templates.js';

function siteWith({ patterns, pageTemplates, derivedAt = '2026-09-01T00:00:00.000Z' } = {}) {
  return {
    id: 1,
    url_file_map: {
      siteRoot: {
        designProfile: patterns ? { derivedAt, pageTypePatterns: patterns } : null,
        pageTemplates: pageTemplates || undefined,
      },
    },
  };
}

describe('resolveOrCreateCanonicalPageTemplate — first page composes and persists', () => {
  test('no design profile at all -> refuses, never invents a template', async () => {
    const saved = [];
    const result = await resolveOrCreateCanonicalPageTemplate(siteWith({}), ['landing'], { saveConfig: async (a) => saved.push(a) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-design-profile');
    assert.equal(result.template, null);
    assert.equal(saved.length, 0);
  });

  test('a profile with no real pattern for any candidate type -> refuses, never invents', async () => {
    const site = siteWith({ patterns: { 'blog-article': { sectionOrder: ['intro'] } } });
    const saved = [];
    const result = await resolveOrCreateCanonicalPageTemplate(site, ['landing', 'service'], { saveConfig: async (a) => saved.push(a) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-real-pattern-for-type');
    assert.equal(saved.length, 0);
  });

  test('a real pattern for the exact type composes and PERSISTS a canonical template', async () => {
    const site = siteWith({
      patterns: { landing: { sectionOrder: ['hero', 'features', 'cta'], textHierarchy: [{ role: 'heading' }, { role: 'body' }], notes: 'always one CTA' } },
    });
    const saved = [];
    const result = await resolveOrCreateCanonicalPageTemplate(site, ['landing'], { saveConfig: async (a) => saved.push(a) });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'composed');
    assert.equal(result.pageType, 'landing');
    assert.deepEqual(result.template.sectionOrder, ['hero', 'features', 'cta']);
    assert.deepEqual(result.template.textRoles, ['heading', 'body']);
    assert.equal(result.template.notes, 'always one CTA');
    assert.equal(result.template.derivedFromProfileVersion, '2026-09-01T00:00:00.000Z');
    assert.equal(result.template.version, PAGE_TEMPLATE_VERSION);

    assert.equal(saved.length, 1, 'the canonical template is persisted, not just returned');
    assert.equal(saved[0].siteId, 1);
    assert.deepEqual(saved[0].urlFileMap.siteRoot.pageTemplates.landing.sectionOrder, ['hero', 'features', 'cta']);
  });

  test('falls back to the next candidate type when the exact type has no real pattern', async () => {
    const site = siteWith({ patterns: { service: { sectionOrder: ['hero', 'features'], textHierarchy: [{ role: 'heading' }] } } });
    const result = await resolveOrCreateCanonicalPageTemplate(site, ['landing', 'service', 'homepage'], { saveConfig: async () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.pageType, 'service');
    assert.deepEqual(result.template.sectionOrder, ['hero', 'features']);
  });
});

describe('resolveOrCreateCanonicalPageTemplate — later pages REUSE, never recompose', () => {
  test('an existing, fresh canonical template is returned as-is — saveConfig is never called', async () => {
    const canonical = {
      version: PAGE_TEMPLATE_VERSION, pageType: 'landing', sectionOrder: ['hero', 'cta'], textRoles: ['heading'],
      notes: null, derivedFromProfileVersion: '2026-09-01T00:00:00.000Z', derivedAt: '2026-09-01T01:00:00.000Z',
    };
    const site = siteWith({
      patterns: { landing: { sectionOrder: ['DIFFERENT — must not be read'], textHierarchy: [] } },
      pageTemplates: { landing: canonical },
    });
    const saved = [];
    const result = await resolveOrCreateCanonicalPageTemplate(site, ['landing'], { saveConfig: async (a) => saved.push(a) });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'existing');
    assert.deepEqual(result.template, canonical, 'the exact persisted canonical row, byte-for-byte — never recomposed from the live profile');
    assert.equal(saved.length, 0, 'reuse must never write');
  });

  test('a real client scenario: the tenth landing page reuses the SAME template the first one established', async () => {
    const site = siteWith({
      patterns: { landing: { sectionOrder: ['hero', 'social-proof', 'pricing', 'cta'], textHierarchy: [{ role: 'eyebrow' }, { role: 'heading' }], notes: 'pricing always last before CTA' } },
    });
    const saveConfig = async (args) => { site.url_file_map = args.urlFileMap; };

    const first = await resolveOrCreateCanonicalPageTemplate(site, ['landing'], { saveConfig });
    assert.equal(first.source, 'composed');

    for (let i = 0; i < 9; i++) {
      const later = await resolveOrCreateCanonicalPageTemplate(site, ['landing'], { saveConfig });
      assert.equal(later.source, 'existing');
      assert.deepEqual(later.template, first.template);
    }
  });
});

describe('resolveOrCreateCanonicalPageTemplate — weekly rescan invalidation', () => {
  test('a changed profile derivedAt (a real weekly re-derivation) invalidates the canonical template and recomposes it', async () => {
    const oldCanonical = {
      version: PAGE_TEMPLATE_VERSION, pageType: 'landing', sectionOrder: ['hero', 'cta'], textRoles: ['heading'],
      notes: null, derivedFromProfileVersion: '2026-09-01T00:00:00.000Z', derivedAt: '2026-09-01T01:00:00.000Z',
    };
    // The rescan already ran and re-derived the profile with a NEW real
    // structure and a new derivedAt — simulating what design-agent/worker.js
    // actually writes when it finishes a weekly rescan job.
    const site = siteWith({
      patterns: { landing: { sectionOrder: ['hero', 'testimonials', 'pricing', 'faq', 'cta'], textHierarchy: [{ role: 'heading' }, { role: 'body' }, { role: 'cta' }], notes: 'redesigned with a pricing table, 2026-09-08' } },
      pageTemplates: { landing: oldCanonical },
      derivedAt: '2026-09-08T00:00:00.000Z',
    });
    const saved = [];
    const result = await resolveOrCreateCanonicalPageTemplate(site, ['landing'], { saveConfig: async (a) => saved.push(a) });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'composed', 'the stale canonical entry is not reused — it is recomposed from the site\'s new real design');
    assert.deepEqual(result.template.sectionOrder, ['hero', 'testimonials', 'pricing', 'faq', 'cta']);
    assert.equal(result.template.derivedFromProfileVersion, '2026-09-08T00:00:00.000Z');
    assert.equal(saved.length, 1, 'the stale entry is overwritten');
    assert.deepEqual(saved[0].urlFileMap.siteRoot.pageTemplates.landing.sectionOrder, ['hero', 'testimonials', 'pricing', 'faq', 'cta']);
  });

  test('an unchanged profile derivedAt keeps reusing — a rescan that found nothing materially different does not thrash the canonical template', async () => {
    const canonical = {
      version: PAGE_TEMPLATE_VERSION, pageType: 'landing', sectionOrder: ['hero', 'cta'], textRoles: ['heading'],
      notes: null, derivedFromProfileVersion: '2026-09-01T00:00:00.000Z', derivedAt: '2026-09-01T01:00:00.000Z',
    };
    const site = siteWith({
      patterns: { landing: { sectionOrder: ['hero', 'cta'], textHierarchy: [{ role: 'heading' }] } },
      pageTemplates: { landing: canonical },
      derivedAt: '2026-09-01T00:00:00.000Z',
    });
    const saved = [];
    const result = await resolveOrCreateCanonicalPageTemplate(site, ['landing'], { saveConfig: async (a) => saved.push(a) });
    assert.equal(result.source, 'existing');
    assert.equal(saved.length, 0);
  });

  test('a site that grows a real pattern for a MORE specific type than its existing canonical fallback picks it up', async () => {
    // The canonical template was first composed against a 'service' fallback
    // (no 'landing' pattern existed yet). The site has since shown real
    // 'landing' pages too, on the SAME profile version — the exact-type
    // match must win over the stale fallback-sourced entry.
    const serviceCanonical = {
      version: PAGE_TEMPLATE_VERSION, pageType: 'service', sectionOrder: ['hero', 'features'], textRoles: ['heading'],
      notes: null, derivedFromProfileVersion: '2026-09-01T00:00:00.000Z', derivedAt: '2026-09-01T01:00:00.000Z',
    };
    const site = siteWith({
      patterns: {
        service: { sectionOrder: ['hero', 'features'], textHierarchy: [{ role: 'heading' }] },
        landing: { sectionOrder: ['hero', 'countdown', 'cta'], textHierarchy: [{ role: 'heading' }] },
      },
      pageTemplates: { service: serviceCanonical },
      derivedAt: '2026-09-01T00:00:00.000Z',
    });
    const saved = [];
    const result = await resolveOrCreateCanonicalPageTemplate(site, ['landing', 'service'], { saveConfig: async (a) => saved.push(a) });
    assert.equal(result.pageType, 'landing');
    assert.deepEqual(result.template.sectionOrder, ['hero', 'countdown', 'cta']);
  });
});

describe('pageTemplateGuidanceText', () => {
  test('renders the same grounded guidance shape as design-aware-composer.js', () => {
    const template = { pageType: 'landing', sectionOrder: ['hero', 'cta'], textRoles: ['heading', 'body'], notes: 'one CTA button' };
    const text = pageTemplateGuidanceText(template);
    assert.match(text, /"landing" pages/);
    assert.match(text, /hero -> cta/);
    assert.match(text, /heading, body/);
    assert.match(text, /one CTA button/);
  });

  test('null template -> null, never a fabricated guidance string', () => {
    assert.equal(pageTemplateGuidanceText(null), null);
  });
});

describe('PAGE_TEMPLATE_TYPES_FOR_GENERATOR', () => {
  test('every wired generator has a real fallback chain', () => {
    for (const [generatorId, types] of Object.entries(PAGE_TEMPLATE_TYPES_FOR_GENERATOR)) {
      assert.ok(Array.isArray(types) && types.length > 0, `${generatorId} must map to at least one page type`);
    }
  });
});
