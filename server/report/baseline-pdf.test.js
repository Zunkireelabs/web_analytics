import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMarkdownSection, recommendationTitle, descriptionRepeatsTitle,
  selectFeaturedRecommendations, scoreStatusWord,
  plainScoreWord, plainIssue, prettyUrl, measuredHealth, buildIssueList, renderBaselineReportHtml,
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

describe('plain-language layer', () => {
  test('plainScoreWord bands use everyday words', () => {
    assert.equal(plainScoreWord(39), 'NEEDS WORK');
    assert.equal(plainScoreWord(40), 'GETTING THERE');
    assert.equal(plainScoreWord(70), 'STRONG');
  });

  test('plainIssue maps real defect labels to plain titles, routes and auto-fixability', () => {
    const alt = plainIssue('Missing alt text');
    assert.equal(alt.title, 'Photos have no description');
    assert.deepEqual(alt.routes, ['SEO']);
    assert.ok(alt.auto);
    assert.deepEqual(plainIssue('Missing FAQ section').routes, ['AEO', 'GEO']);
    assert.equal(plainIssue('Missing FAQ section').auto, null);
  });

  test('an unrecognized label falls back to its own cleaned text, never an invented claim', () => {
    const p = plainIssue('weird-internal_label');
    assert.equal(p.title, 'Weird internal label');
    assert.deepEqual(p.routes, []);
  });

  test('prettyUrl strips protocol, www, query and trailing slash', () => {
    assert.equal(prettyUrl('https://www.site.com/a/b/?x=1#y'), 'site.com/a/b');
  });

  test('measuredHealth treats a stored 0 with no audit as not measured', () => {
    assert.equal(measuredHealth({ healthScore: 0 }, { auditFindings: null }), null);
    assert.equal(measuredHealth({ healthScore: 0 }, { auditFindings: { total: 3 } }), 0);
    assert.equal(measuredHealth({ healthScore: 34 }, {}), 34);
    assert.equal(measuredHealth({}, {}), null);
  });

  test('buildIssueList groups defects that share a plain title and keeps a real example page', () => {
    const list = buildIssueList({ auditFindings: { topDefects: [
      { issue: 'Missing schema markup', priority: 'high', pages: 10, examplePages: ['https://s.com/a'] },
      { issue: 'Missing structured data', priority: 'medium', pages: 5, examplePages: ['https://s.com/b'] },
    ] } });
    assert.equal(list.length, 1);
    assert.equal(list[0].pages, 15);
    assert.equal(list[0].example, 'https://s.com/a');
  });

  test('renders five light pages with no dark panels and says "not measured" when data is missing', () => {
    const html = renderBaselineReportHtml({
      generated_at: '2026-10-28T00:00:00Z', narrative_md: '', kpi_snapshot: { healthScore: 0 },
      issues_snapshot: { auditFindings: null, aiVisibility: { available: false }, competitors: [], openRecommendations: { total: 0, byPriority: {}, items: [] } },
    }, { name: 'Acme' });
    assert.equal((html.match(/<section class="page/g) || []).length, 5);
    assert.match(html, /NOT MEASURED YET/);
    assert.doesNotMatch(html, /background:\s*#000|background:\s*\$\{BRAND\.navy\}/);
  });
});

describe('baseline report brand colour', () => {
  const report = {
    generated_at: '2026-10-28T00:00:00Z', narrative_md: '', kpi_snapshot: { healthScore: 34 },
    issues_snapshot: { auditFindings: null, aiVisibility: { available: false }, competitors: [], openRecommendations: { total: 0, byPriority: {}, items: [] } },
  };
  test('uses the client\'s stored accent colour', () => {
    const html = renderBaselineReportHtml(report, { name: 'Acme', url_file_map: { siteRoot: { designProfile: { color: { accent: '#c8a96e' } } } } });
    assert.match(html, /--red:#c8a96e/);
  });
  test('falls back to Zunkiree green when the client has no colour', () => {
    assert.match(renderBaselineReportHtml(report, { name: 'Acme' }), /--red:#76b900/);
  });
  test('warning reds stay red even when the accent is not', () => {
    const html = renderBaselineReportHtml(report, { name: 'Acme', url_file_map: { siteRoot: { designProfile: { color: { accent: '#c8a96e' } } } } });
    assert.match(html, /NEEDS WORK/);
    assert.match(html, /color:#eb1600/);
  });
});
