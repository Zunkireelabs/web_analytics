import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMarkdownSection, recommendationTitle, descriptionRepeatsTitle,
  selectFeaturedRecommendations, scoreStatusWord,
} from './baseline-pdf.js';

// Regression coverage for real defects found by generating and inspecting
// the actual Admizz Education PDF (not just checking it in a browser).

describe('extractMarkdownSection — quotes the model\'s real prose verbatim', () => {
  const MD = '# Baseline Report\n\n## Where Your Website Stood\n\nReal sentence one. Real sentence two.\n\n## Issues We Found\n\nOther section text.';

  test('returns the exact text under the named heading, nothing else', () => {
    assert.equal(extractMarkdownSection(MD, 'Where Your Website Stood'), 'Real sentence one. Real sentence two.');
  });

  test('a missing heading returns empty string, never a fabricated fallback', () => {
    assert.equal(extractMarkdownSection(MD, 'Nonexistent Heading'), '');
  });

  test('empty/missing markdown is a no-op', () => {
    assert.equal(extractMarkdownSection('', 'Anything'), '');
    assert.equal(extractMarkdownSection(null, 'Anything'), '');
  });
});

describe('recommendationTitle — derives a short label from real type/issue fields', () => {
  test('recognized types get their fixed label', () => {
    assert.equal(recommendationTitle({ type: 'faq', issue: 'Add FAQ' }), 'Add FAQ');
    assert.equal(recommendationTitle({ type: 'landing-page', issue: 'Generate Landing Page' }), 'Generate Landing Page');
    assert.equal(recommendationTitle({ type: 'broken-link-fix', issue: 'Remove invalid citation' }), 'Remove Invalid Citation');
  });

  test('expand-content is disambiguated by its real issue text, not left generic', () => {
    assert.equal(recommendationTitle({ type: 'expand-content', issue: 'Add comparison, alternatives, or "best of" content' }), 'Add Comparison Content');
    assert.equal(recommendationTitle({ type: 'expand-content', issue: 'Add author/byline markup so AI engines attribute the content' }), 'Add Author/Byline Markup');
  });

  test('an unrecognized type falls back to its own Title-Cased name, never an invented description', () => {
    assert.equal(recommendationTitle({ type: 'some-new-type', issue: 'whatever' }), 'Some New Type');
  });
});

describe('descriptionRepeatsTitle — the real Admizz report bug: "Add FAQ" / "Add FAQ"', () => {
  test('an identical (case/punctuation-insensitive) description is flagged so it is not printed twice', () => {
    assert.equal(descriptionRepeatsTitle('Add FAQ', 'Add FAQ'), true);
    assert.equal(descriptionRepeatsTitle('Add FAQ', 'add faq.'), true);
    assert.equal(descriptionRepeatsTitle('Remove Invalid Citation', 'Remove invalid citation'), true);
  });

  test('a genuinely different supporting sentence is kept', () => {
    assert.equal(descriptionRepeatsTitle('Add Comparison Content', 'Add comparison, alternatives, or "best of" content — generative engines disproportionately cite this shape.'), false);
  });
});

describe('selectFeaturedRecommendations — one representative per issue type, highest priority first', () => {
  const ITEMS = [
    { type: 'faq', issue: 'Add FAQ', priority: 'high' },
    { type: 'expand-content', issue: 'Add author/byline markup', priority: 'high' },
    { type: 'expand-content', issue: 'Add author/byline markup', priority: 'high' }, // real dup: two different pages, same issue
    { type: 'expand-content', issue: 'Add comparison content', priority: 'high' },
    { type: 'broken-link-fix', issue: 'Remove invalid citation', priority: 'high' },
    { type: 'schema', issue: 'Add schema markup', priority: 'medium' },
  ];

  test('never shows the same derived title twice, even though the underlying records are real and distinct', () => {
    const out = selectFeaturedRecommendations(ITEMS, 8);
    const titles = out.map((i) => recommendationTitle(i));
    assert.equal(new Set(titles).size, titles.length);
    assert.equal(titles.length, 5, 'five DISTINCT issue types exist in the fixture, not six raw rows');
  });

  test('a lower-priority distinct type still gets a slot before the cap, never dropped for a duplicate', () => {
    const out = selectFeaturedRecommendations(ITEMS, 8);
    assert.ok(out.some((i) => i.type === 'schema'), 'Add Schema Markup must appear even though it is medium priority, because every high-priority SLOT after dedup is already used by a distinct type');
  });

  test('respects the max even with more distinct types than slots', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ type: `t${i}`, issue: `issue ${i}`, priority: 'high' }));
    assert.equal(selectFeaturedRecommendations(many, 8).length, 8);
  });
});

describe('scoreStatusWord', () => {
  test('bands match the report\'s own thresholds', () => {
    assert.equal(scoreStatusWord(20), 'NEEDS ATTENTION');
    assert.equal(scoreStatusWord(39), 'NEEDS ATTENTION');
    assert.equal(scoreStatusWord(40), 'DEVELOPING');
    assert.equal(scoreStatusWord(69), 'DEVELOPING');
    assert.equal(scoreStatusWord(70), 'STRONG');
    assert.equal(scoreStatusWord(100), 'STRONG');
  });
});
