import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pageStructureGuidance, hasPageStructureGuidance } from './design-aware-composer.js';

function siteWithPatterns(patterns) {
  return { url_file_map: { siteRoot: { designProfile: { pageTypePatterns: patterns } } } };
}

describe('pageStructureGuidance', () => {
  test('no design profile at all -> null, never fabricated', () => {
    assert.equal(pageStructureGuidance({}, 'landing'), null);
    assert.equal(pageStructureGuidance(null, 'landing'), null);
  });

  test('a profile with no pageTypePatterns -> null', () => {
    assert.equal(pageStructureGuidance({ url_file_map: { siteRoot: { designProfile: {} } } }, 'landing'), null);
  });

  test('a real observed pattern for the exact page type is used verbatim', () => {
    const site = siteWithPatterns({
      landing: { sectionOrder: ['hero', 'features', 'pricing', 'cta'], textHierarchy: [{ role: 'eyebrow' }, { role: 'heading' }, { role: 'body' }], notes: 'always a single pricing table' },
    });
    const guidance = pageStructureGuidance(site, 'landing');
    assert.match(guidance, /hero -> features -> pricing -> cta/);
    assert.match(guidance, /eyebrow, heading, body/);
    assert.match(guidance, /always a single pricing table/);
  });

  test('no pattern for the requested type, but a fallback type has one — uses the fallback, names it', () => {
    const site = siteWithPatterns({
      service: { sectionOrder: ['hero', 'features'], textHierarchy: [{ role: 'heading' }] },
    });
    const guidance = pageStructureGuidance(site, 'landing', { fallbackPageTypes: ['service', 'homepage'] });
    assert.match(guidance, /"service" pages/);
    assert.match(guidance, /hero -> features/);
  });

  test('neither the requested type nor any fallback exists -> null, never invents a structure', () => {
    const site = siteWithPatterns({ 'blog-article': { sectionOrder: ['intro', 'body'] } });
    assert.equal(pageStructureGuidance(site, 'landing', { fallbackPageTypes: ['service', 'homepage'] }), null);
  });

  test('an empty pattern object (captured but genuinely nothing observed) counts as no match', () => {
    const site = siteWithPatterns({ landing: { sectionOrder: [], textHierarchy: [] } });
    assert.equal(pageStructureGuidance(site, 'landing'), null);
  });

  test('duplicate roles across sections are deduped in the guidance', () => {
    const site = siteWithPatterns({
      landing: { sectionOrder: ['hero'], textHierarchy: [{ role: 'heading' }, { role: 'body' }, { role: 'heading' }] },
    });
    const guidance = pageStructureGuidance(site, 'landing');
    assert.match(guidance, /heading, body(?!.*heading)/s);
  });

  test('hasPageStructureGuidance mirrors pageStructureGuidance\'s null/non-null verdict', () => {
    const withPatterns = siteWithPatterns({ landing: { sectionOrder: ['hero'] } });
    assert.equal(hasPageStructureGuidance(withPatterns, 'landing'), true);
    assert.equal(hasPageStructureGuidance({}, 'landing'), false);
  });
});

describe('pageStructureGuidance — canonical pageTemplates take priority', () => {
  test('a persisted canonical template is used VERBATIM, not re-derived from the live profile', () => {
    const site = {
      url_file_map: {
        siteRoot: {
          designProfile: { pageTypePatterns: { landing: { sectionOrder: ['DIFFERENT — must not be read'], textHierarchy: [] } } },
          pageTemplates: { landing: { pageType: 'landing', sectionOrder: ['hero', 'pricing', 'cta'], textRoles: ['heading'], notes: 'canonical, established by the first landing page' } },
        },
      },
    };
    const guidance = pageStructureGuidance(site, 'landing');
    assert.match(guidance, /hero -> pricing -> cta/);
    assert.match(guidance, /established by the first landing page/);
  });

  test('no canonical entry falls back to live pageTypePatterns derivation, unchanged behavior', () => {
    const site = { url_file_map: { siteRoot: { designProfile: { pageTypePatterns: { landing: { sectionOrder: ['hero', 'cta'], textHierarchy: [{ role: 'heading' }] } } } } } };
    const guidance = pageStructureGuidance(site, 'landing');
    assert.match(guidance, /hero -> cta/);
  });

  test('a canonical entry for a fallback type is preferred over a live pattern for the exact type', () => {
    // Mirrors design-agent/lib/page-templates.js's own most-specific-match
    // discipline: candidates are tried in order, and the canonical lookup
    // uses the SAME candidate order as the live-pattern fallback.
    const site = {
      url_file_map: {
        siteRoot: {
          designProfile: { pageTypePatterns: { landing: { sectionOrder: ['live-landing-pattern'], textHierarchy: [] } } },
          pageTemplates: { landing: { pageType: 'landing', sectionOrder: ['canonical-landing'], textRoles: [] } },
        },
      },
    };
    const guidance = pageStructureGuidance(site, 'landing', { fallbackPageTypes: ['service'] });
    assert.match(guidance, /canonical-landing/);
    assert.doesNotMatch(guidance, /live-landing-pattern/);
  });
});
