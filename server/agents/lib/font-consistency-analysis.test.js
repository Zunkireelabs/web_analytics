import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasInlineFontSizeOverride, buildFontSizeOverrideRemoved, findFontSizeOutliers,
  extractScopedFontSizeDeclaration, isFlatLength, buildScopedFontSizeFix,
} from './font-consistency-analysis.js';

describe('hasInlineFontSizeOverride', () => {
  test('true when the inline style attribute sets font-size', () => {
    assert.equal(hasInlineFontSizeOverride('<h1 style="font-size: 18px; color: red;">Hi</h1>'), true);
  });
  test('false when there is no style attribute', () => {
    assert.equal(hasInlineFontSizeOverride('<h1 class="title">Hi</h1>'), false);
  });
  test('false when the style attribute sets other properties only', () => {
    assert.equal(hasInlineFontSizeOverride('<h1 style="color: red;">Hi</h1>'), false);
  });
});

describe('buildFontSizeOverrideRemoved', () => {
  test('removes only the font-size declaration, keeping other declarations', () => {
    const out = buildFontSizeOverrideRemoved('<h1 style="font-size: 18px; color: red;">Hi</h1>');
    assert.equal(out, '<h1 style="color: red;">Hi</h1>');
  });

  test('drops the whole style attribute when font-size was the only declaration', () => {
    const out = buildFontSizeOverrideRemoved('<h1 style="font-size: 18px;">Hi</h1>');
    assert.equal(out, '<h1>Hi</h1>');
  });

  test('returns null when there is no inline font-size to remove', () => {
    assert.equal(buildFontSizeOverrideRemoved('<h1 class="title">Hi</h1>'), null);
    assert.equal(buildFontSizeOverrideRemoved('<h1 style="color: red;">Hi</h1>'), null);
  });
});

function page(url, headings = [], paragraphs = [], pageType = null) {
  return { url, pageType, headings, paragraphs };
}
function h(tag, fontSize, outerHtml, inlineStyle = null, classes = '', ancestorClass = null, rawFontSizeDeclaration = null) {
  return { tag, fontSize, outerHtml, inlineStyle, classes, text: '', ancestorClass, rawFontSizeDeclaration };
}

describe('findFontSizeOutliers', () => {
  test('flags an h1 that differs from the real majority across enough distinct pages', () => {
    const pages = [
      page('https://example.com/a', [h('h1', '32px', '<h1>A</h1>')]),
      page('https://example.com/b', [h('h1', '32px', '<h1>B</h1>')]),
      page('https://example.com/c', [h('h1', '18px', '<h1 style="font-size: 18px;">C</h1>')]),
    ];
    const outliers = findFontSizeOutliers(pages);
    assert.equal(outliers.length, 1);
    assert.equal(outliers[0].url, 'https://example.com/c');
    assert.equal(outliers[0].expectedFontSize, '32px');
    assert.equal(outliers[0].actualFontSize, '18px');
  });

  test('does not flag anything when fewer than 3 distinct pages have that group', () => {
    const pages = [
      page('https://example.com/a', [h('h1', '32px', '<h1>A</h1>')]),
      page('https://example.com/b', [h('h1', '18px', '<h1>B</h1>')]),
    ];
    assert.deepEqual(findFontSizeOutliers(pages), []);
  });

  test('does not flag anything when there is no real majority (site genuinely varies by design)', () => {
    const pages = [
      page('https://example.com/a', [h('h1', '32px', '<h1>A</h1>')]),
      page('https://example.com/b', [h('h1', '28px', '<h1>B</h1>')]),
      page('https://example.com/c', [h('h1', '24px', '<h1>C</h1>')]),
    ];
    assert.deepEqual(findFontSizeOutliers(pages), []);
  });

  test('groups headings by tag separately (h1 outlier does not pollute h2 group)', () => {
    const pages = [
      page('https://example.com/a', [h('h1', '32px', '<h1>A</h1>'), h('h2', '20px', '<h2>A2</h2>')]),
      page('https://example.com/b', [h('h1', '32px', '<h1>B</h1>'), h('h2', '20px', '<h2>B2</h2>')]),
      page('https://example.com/c', [h('h1', '18px', '<h1 style="font-size: 18px;">C</h1>'), h('h2', '20px', '<h2>C2</h2>')]),
    ];
    const outliers = findFontSizeOutliers(pages);
    assert.equal(outliers.length, 1);
    assert.equal(outliers[0].group, 'h1');
  });

  test('empty input -> empty result', () => {
    assert.deepEqual(findFontSizeOutliers([]), []);
  });

  test('a template with its own confirmed majority is not flagged against a different sitewide majority', () => {
    // Three landing-style pages consistently at 60px, three other pages
    // consistently at 48px — a real, confirmed per-template design decision
    // on this site, not a defect. Neither bucket should be flagged.
    const pages = [
      page('https://example.com/', [h('h1', '60px', '<h1>Home</h1>')], [], 'homepage'),
      page('https://example.com/landing-a', [h('h1', '60px', '<h1>A</h1>')], [], 'landing'),
      page('https://example.com/landing-b', [h('h1', '60px', '<h1>B</h1>')], [], 'landing'),
      page('https://example.com/blog', [h('h1', '48px', '<h1>Blog</h1>')], [], 'blog-listing'),
      page('https://example.com/faq', [h('h1', '48px', '<h1>FAQ</h1>')], [], 'faq'),
      page('https://example.com/terms', [h('h1', '48px', '<h1>Terms</h1>')], [], 'legal'),
    ];
    assert.deepEqual(findFontSizeOutliers(pages), []);
  });

  test('a page type with too few sampled pages falls back to the sitewide majority', () => {
    const pages = [
      page('https://example.com/a', [h('h1', '32px', '<h1>A</h1>')], [], 'other'),
      page('https://example.com/b', [h('h1', '32px', '<h1>B</h1>')], [], 'other'),
      page('https://example.com/c', [h('h1', '32px', '<h1>C</h1>')], [], 'other'),
      // Only one 'landing' page — not enough evidence for its own bucket, so
      // it is judged against the sitewide majority above and flagged.
      page('https://example.com/lp', [h('h1', '18px', '<h1 style="font-size: 18px;">LP</h1>')], [], 'landing'),
    ];
    const outliers = findFontSizeOutliers(pages);
    assert.equal(outliers.length, 1);
    assert.equal(outliers[0].url, 'https://example.com/lp');
    assert.equal(outliers[0].scope, 'site');
  });

  test('a class-driven outlier carries a resolvable siteConvention when the bucket has one', () => {
    const pages = [
      page('https://example.com/a', [h('h1', '32px', '<h1 class="text-h1">A</h1>', null, 'text-h1')]),
      page('https://example.com/b', [h('h1', '32px', '<h1 class="text-h1">B</h1>', null, 'text-h1')]),
      page('https://example.com/c', [h('h1', '18px', '<h1 class="hero-sm">C</h1>', null, 'hero-sm')]),
    ];
    const outliers = findFontSizeOutliers(pages);
    assert.equal(outliers.length, 1);
    assert.equal(outliers[0].siteConvention, 'text-h1');
  });

  test('siteConvention is null when the outlier already carries the resolved convention (not a class problem)', () => {
    const pages = [
      page('https://example.com/a', [h('h1', '32px', '<h1 class="text-h1">A</h1>', null, 'text-h1')]),
      page('https://example.com/b', [h('h1', '32px', '<h1 class="text-h1">B</h1>', null, 'text-h1')]),
      page('https://example.com/c', [h('h1', '18px', '<h1 class="text-h1">C</h1>', null, 'text-h1')]),
    ];
    const outliers = findFontSizeOutliers(pages);
    assert.equal(outliers.length, 1);
    assert.equal(outliers[0].siteConvention, null);
  });

  test('an unclassed outlier with a page-unique ancestor wrapper and a flat value gets a scopedSelector', () => {
    // Chayce's own real shape: bare <h1>, no class, styled via ".hiw-hero h1"
    // — a wrapper class no other sampled page uses.
    const pages = [
      page('https://example.com/a', [h('h1', '48px', '<h1>A</h1>', null, '', 'page-hero', '48px')]),
      page('https://example.com/b', [h('h1', '48px', '<h1>B</h1>', null, '', 'page-hero', '48px')]),
      page('https://example.com/c', [h('h1', '48px', '<h1>C</h1>', null, '', 'page-hero', '48px')]),
      page('https://example.com/how-it-works', [h('h1', '74px', '<h1>D</h1>', null, '', 'hiw-hero', '74px')]),
    ];
    const outliers = findFontSizeOutliers(pages);
    assert.equal(outliers.length, 1);
    assert.deepEqual(outliers[0].scopedSelector, { ancestorClass: 'hiw-hero', tag: 'h1' });
    assert.equal(outliers[0].scopedButFluid, null);
  });

  test('an ancestor wrapper class reused across other pages never gets a scopedSelector (real cross-page blast radius)', () => {
    const pages = [
      page('https://example.com/a', [h('h1', '48px', '<h1>A</h1>', null, '', 'page-hero', '48px')]),
      page('https://example.com/b', [h('h1', '48px', '<h1>B</h1>', null, '', 'page-hero', '48px')]),
      page('https://example.com/c', [h('h1', '48px', '<h1>C</h1>', null, '', 'page-hero', '48px')]),
      // Same wrapper class as the majority pages, not unique to itself.
      page('https://example.com/d', [h('h1', '30px', '<h1>D</h1>', null, '', 'page-hero', '30px')]),
    ];
    const outliers = findFontSizeOutliers(pages);
    assert.equal(outliers.length, 1);
    assert.equal(outliers[0].scopedSelector, null);
  });

  test('a page-unique ancestor wrapper with a fluid declared value is reported as scopedButFluid, not auto-fixable', () => {
    const pages = [
      page('https://example.com/a', [h('h1', '48px', '<h1>A</h1>', null, '', 'page-hero', '48px')]),
      page('https://example.com/b', [h('h1', '48px', '<h1>B</h1>', null, '', 'page-hero', '48px')]),
      page('https://example.com/c', [h('h1', '48px', '<h1>C</h1>', null, '', 'page-hero', '48px')]),
      page('https://example.com/how-it-works', [h('h1', '74px', '<h1>D</h1>', null, '', 'hiw-hero', 'clamp(40px,6vw,74px)')]),
    ];
    const outliers = findFontSizeOutliers(pages);
    assert.equal(outliers.length, 1);
    assert.equal(outliers[0].scopedSelector, null);
    assert.equal(outliers[0].scopedButFluid, 'clamp(40px,6vw,74px)');
  });
});

describe('extractScopedFontSizeDeclaration', () => {
  test('finds the exact declaration for an ancestor-wrapper + tag selector', () => {
    const html = '<style>.hiw-hero h1{color:#fff;font-size:clamp(40px,6vw,74px);line-height:1.04}</style>';
    const found = extractScopedFontSizeDeclaration(html, 'hiw-hero', 'h1');
    assert.equal(found.value, 'clamp(40px,6vw,74px)');
    assert.equal(found.declarationText, '.hiw-hero h1{color:#fff;font-size:clamp(40px,6vw,74px);line-height:1.04}');
  });

  test('does not match a descendant rule for a different element under the same wrapper', () => {
    const html = '<style>.hiw-hero h1 em{color:gold}.hiw-hero p{font-size:18px}</style>';
    assert.equal(extractScopedFontSizeDeclaration(html, 'hiw-hero', 'h1'), null);
  });

  test('refuses when the selector appears more than once (ambiguous)', () => {
    const html = '<style>.hiw-hero h1{font-size:48px}</style><style>.hiw-hero h1{font-size:48px}</style>';
    assert.equal(extractScopedFontSizeDeclaration(html, 'hiw-hero', 'h1'), null);
  });

  test('refuses when the matched rule has no font-size at all', () => {
    const html = '<style>.hiw-hero h1{color:#fff}</style>';
    assert.equal(extractScopedFontSizeDeclaration(html, 'hiw-hero', 'h1'), null);
  });

  test('refuses when the selector is not found at all', () => {
    assert.equal(extractScopedFontSizeDeclaration('<style>.other h1{font-size:20px}</style>', 'hiw-hero', 'h1'), null);
  });
});

describe('isFlatLength', () => {
  test('true for plain px/pt lengths', () => {
    assert.equal(isFlatLength('48px'), true);
    assert.equal(isFlatLength('12pt'), true);
  });
  test('false for fluid/dynamic expressions', () => {
    assert.equal(isFlatLength('clamp(40px,6vw,74px)'), false);
    assert.equal(isFlatLength('calc(1rem + 2vw)'), false);
    assert.equal(isFlatLength('4vw'), false);
    assert.equal(isFlatLength('120%'), false);
    assert.equal(isFlatLength('var(--h1-size)'), false);
  });
});

describe('buildScopedFontSizeFix', () => {
  test('swaps only the font-size value, keeping the rest of the declaration byte-identical', () => {
    const html = '<style>.hiw-hero h1{color:#fff;font-size:74px;line-height:1.04}</style>';
    const fix = buildScopedFontSizeFix(html, 'hiw-hero', 'h1', '48px');
    assert.equal(fix.anchorHtml, '.hiw-hero h1{color:#fff;font-size:74px;line-height:1.04}');
    assert.equal(fix.replacement, '.hiw-hero h1{color:#fff;font-size:48px;line-height:1.04}');
  });

  test('refuses (returns null) when the real value is a fluid expression, never flattens it', () => {
    const html = '<style>.hiw-hero h1{font-size:clamp(40px,6vw,74px)}</style>';
    assert.equal(buildScopedFontSizeFix(html, 'hiw-hero', 'h1', '48px'), null);
  });

  test('refuses when the declaration already matches the expected value (would be a no-op)', () => {
    const html = '<style>.hiw-hero h1{font-size:48px}</style>';
    assert.equal(buildScopedFontSizeFix(html, 'hiw-hero', 'h1', '48px'), null);
  });

  test('refuses when the selector cannot be uniquely located, same as extractScopedFontSizeDeclaration', () => {
    assert.equal(buildScopedFontSizeFix('<style>.other h1{font-size:20px}</style>', 'hiw-hero', 'h1', '48px'), null);
  });
});
