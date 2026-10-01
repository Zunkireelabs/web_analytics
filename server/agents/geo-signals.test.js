import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { recommendationsFor } from './geo-signals.js';

// A page with every GEO signal present except the one under test in each
// case below, so recommendationsFor only ever fires the one rule being
// checked.
function analysisWith(overrides) {
  return {
    hasAuthorSignal: true,
    hasFreshnessSignal: true,
    hasComparisonContent: true,
    hasExternalCitations: true,
    hasReviewSchema: true,
    questionHeadingCount: 1,
    isArticlePage: true,
    hasVisibleFaqContent: false,
    ...overrides,
  };
}

describe('geo-signals — recommendationsFor', () => {
  test('missing review/rating schema is informational only (generatorId: null)', () => {
    const recs = recommendationsFor(analysisWith({ hasReviewSchema: false }), '/p', 'query', []);

    assert.equal(recs.length, 1);
    assert.equal(recs[0].generatorId, null, 'schema.js can never honestly draft Review schema without real review data on the page — see the rule\'s own comment');
  });

  test('the other three GEO signals still route to a real generator', () => {
    const cases = [
      // Routed to 'schema' (dateModified/datePublished JSON-LD), not
      // expand-content's 'freshness-date' focus — that focus drafts a
      // VISIBLE "Last Updated" section. See geo-signals.js's own comment.
      { key: 'hasFreshnessSignal', generatorId: 'schema' },
      { key: 'hasComparisonContent', generatorId: 'expand-content' },
      { key: 'hasExternalCitations', generatorId: 'expand-content' },
    ];
    for (const { key, generatorId } of cases) {
      // comparison content is only missing for a comparison-intent query
      const recs = recommendationsFor(analysisWith({ [key]: false }), '/p', 'acme vs rival', []);
      assert.equal(recs.length, 1, `expected exactly one recommendation for ${key}`);
      assert.equal(recs[0].generatorId, generatorId, `${key} should still route to ${generatorId}`);
    }
  });

  // The author-byline rule is retired platform-wide (2026-09-24): a missing
  // author signal no longer produces any recommendation at all, since
  // expand-content's author-byline focus (its only remediation route) no
  // longer drafts anything — routing here would only ever create a
  // dead-end, permanently-failing draft.
  test('a missing author signal produces no recommendation (retired)', () => {
    const recs = recommendationsFor(analysisWith({ hasAuthorSignal: false }), '/p', 'query', []);
    assert.equal(recs.length, 0);
  });

  test('a question-heading gap still routes to qa-content', () => {
    const recs = recommendationsFor(analysisWith({ questionHeadingCount: 0 }), '/p', 'query', []);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].generatorId, 'qa-content');
  });
});

describe('geo-signals — applicability gates', () => {
  test('comparison content is not asked for without a comparison-intent query', () => {
    const recs = recommendationsFor(analysisWith({ hasComparisonContent: false }), '/p', 'acme pricing', []);
    assert.equal(recs.length, 0);
  });

  test('date, citation and review signals are not asked for on a non-article page', () => {
    const recs = recommendationsFor(
      analysisWith({ isArticlePage: false, hasFreshnessSignal: false, hasExternalCitations: false, hasReviewSchema: false }),
      '/services/web', 'web design', [],
    );
    assert.equal(recs.length, 0);
  });

  test('qa-content is skipped when a visible FAQ exists, even with no h1-h3 question headings', () => {
    const recs = recommendationsFor(analysisWith({ questionHeadingCount: 0, hasVisibleFaqContent: true }), '/p', 'q', []);
    assert.equal(recs.length, 0);
  });
});

import { citationPagesBeyondCap } from './geo-signals.js';
describe('citation action cap', () => {
  const page = (url, impressions, focus = 'external-citations') => ({ page: url, impressions, recommendations: [{ params: { focus } }] });
  test('only the top pages by impressions keep the citations action', () => {
    const pages = [page('a', 5), page('b', 90), page('c', 40), page('d', 1)];
    assert.deepEqual([...citationPagesBeyondCap(pages, 2)].sort(), ['a', 'd']);
  });
  test('pages without the citations signal never count toward the cap', () => {
    const pages = [page('a', 5, 'comparison-content'), page('b', 90), page('c', 40)];
    assert.equal(citationPagesBeyondCap(pages, 2).size, 0);
  });
});
