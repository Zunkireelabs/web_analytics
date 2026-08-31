import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { segmentPage, segmentSite, buildPageTypePatterns } from './segment.js';

function block(overrides = {}) {
  return {
    order: 0, tag: 'div', landmark: null, classes: '', top: 0, height: 200, width: 1440, viewportWidth: 1440,
    backgroundColor: 'rgb(255,255,255)', padding: '16px', headingLevel: null, headingText: null,
    headingStyle: null, headingClasses: '', bodyText: null, bodyStyle: null, bodyClasses: '',
    ctaText: null, ctaTag: null, ctaClasses: '', imageCount: 0, hasBackgroundImage: false,
    accordionLike: false, accordionClasses: { wrapper: '', item: '', trigger: '', panel: '' },
    cardLike: false, cardClasses: { wrapper: '', body: '' }, listClasses: { wrapper: '', item: '' }, linkClasses: '',
    ...overrides,
  };
}

describe('segmentPage', () => {
  test('a landmark header/footer overrides role guessing entirely', () => {
    const sections = segmentPage([
      block({ order: 0, landmark: 'header', height: 80 }),
      block({ order: 1, headingLevel: 1, headingText: 'Welcome', height: 400, top: 80 }),
      block({ order: 2, landmark: 'footer', height: 100, top: 480 }),
    ]);
    assert.equal(sections[0].role, 'header');
    assert.equal(sections[2].role, 'footer');
  });

  test('the first non-landmark block with an h1 reads as hero', () => {
    const sections = segmentPage([block({ headingLevel: 1, headingText: 'Big claim' })]);
    assert.equal(sections[0].role, 'hero');
  });

  test('keyword matching beats positional guessing — an FAQ heading is never misread as hero even if first', () => {
    const sections = segmentPage([block({ headingLevel: 1, headingText: 'Frequently Asked Questions' })]);
    assert.equal(sections[0].role, 'faq');
  });

  test('precedes/follows are role hints to neighbours, not indices', () => {
    const sections = segmentPage([
      block({ order: 0, landmark: 'header' }),
      block({ order: 1, headingText: 'Pricing plans', top: 80 }),
      block({ order: 2, landmark: 'footer', top: 300 }),
    ]);
    assert.equal(sections[1].follows, 'header');
    assert.equal(sections[1].precedes, 'footer');
    assert.equal(sections[0].follows, null);
    assert.equal(sections[2].precedes, null);
  });

  test('width bucket is derived from the ratio of block width to viewport width', () => {
    const [full] = segmentPage([block({ width: 1440, viewportWidth: 1440 })]);
    const [narrow] = segmentPage([block({ width: 400, viewportWidth: 1440 })]);
    assert.equal(full.width, 'full');
    assert.equal(narrow.width, 'narrow');
  });

  test('a real accordion/card carries its live classes through into components, never invented', () => {
    const [section] = segmentPage([block({
      accordionLike: true,
      accordionClasses: { wrapper: 'divide-y', item: 'divide-y', trigger: 'font-semibold', panel: 'text-gray-600' },
    })]);
    const accordion = section.components.find((c) => c.type === 'accordion');
    assert.ok(accordion);
    assert.equal(accordion.classes.trigger, 'font-semibold');
  });

  // The bug this closes: capture.js reads linkClasses per block, but until
  // now textHierarchyOf silently dropped it, so typography.link had no real
  // evidence in `sections` to verify against — the exact slot
  // correctLinkTypography exists to fix (a block's first <a> is usually its
  // CTA button) had no trail proving the site's real inline-link style.
  test('a real inline link (never the CTA) carries through into textHierarchy as its own role', () => {
    const [section] = segmentPage([block({ linkClasses: 'text-blue-600 underline' })]);
    const link = section.textHierarchy.find((h) => h.role === 'link');
    assert.ok(link);
    assert.equal(link.classes, 'text-blue-600 underline');
    assert.equal(link.tag, 'a');
  });

  test('a block with no real inline link contributes no link entry', () => {
    const [section] = segmentPage([block({ linkClasses: '' })]);
    assert.equal(section.textHierarchy.some((h) => h.role === 'link'), false);
  });

  test('spacing.before/after are the pixel gap to neighbouring blocks, clamped at zero', () => {
    const sections = segmentPage([
      block({ order: 0, top: 0, height: 100 }),
      block({ order: 1, top: 140, height: 100 }),
    ]);
    assert.equal(sections[0].spacing.after, 40);
    assert.equal(sections[1].spacing.before, 40);
  });
});

describe('segmentSite / buildPageTypePatterns', () => {
  test('segmentSite preserves url/pageType/title and segments each page independently', () => {
    const out = segmentSite({
      pages: [
        { url: 'https://x.com/', pageType: 'homepage', title: 'Home', blocks: [block({ headingLevel: 1, headingText: 'Hi' })] },
        { url: 'https://x.com/faq', pageType: 'faq', title: 'FAQ', blocks: [block({ headingText: 'Frequently Asked Questions' })] },
      ],
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].pageType, 'homepage');
    assert.equal(out[1].sections[0].role, 'faq');
  });

  test('buildPageTypePatterns groups by pageType and records the observed section order', () => {
    const segmented = segmentSite({
      pages: [{ url: 'https://x.com/', pageType: 'homepage', title: '', blocks: [
        block({ order: 0, landmark: 'header' }),
        block({ order: 1, headingLevel: 1, headingText: 'Hi', top: 80 }),
        block({ order: 2, landmark: 'footer', top: 300 }),
      ] }],
    });
    const patterns = buildPageTypePatterns(segmented);
    assert.deepEqual(patterns.homepage.sectionOrder, ['header', 'hero', 'footer']);
    assert.deepEqual(patterns.homepage.exampleUrls, ['https://x.com/']);
  });
});
