import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hasInlineFontSizeOverride, buildFontSizeOverrideRemoved, findFontSizeOutliers } from './font-consistency-analysis.js';

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

function page(url, headings = [], paragraphs = []) {
  return { url, headings, paragraphs };
}
function h(tag, fontSize, outerHtml, inlineStyle = null) {
  return { tag, fontSize, outerHtml, inlineStyle, classes: '', text: '' };
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
});
