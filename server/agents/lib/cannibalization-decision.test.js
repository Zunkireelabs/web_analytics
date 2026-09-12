import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickCannibalizationWinner } from './cannibalization-decision.js';

describe('pickCannibalizationWinner', () => {
  test('the page with real, dominant clicks wins over one with only impressions', () => {
    const { winner, losers } = pickCannibalizationWinner('top ai companies in nepal', [
      { page: 'https://example.com/blog/top-ai-companies-nepal-2026/', clicks: 12, impressions: 80, avgPosition: 3.2 },
      { page: 'https://example.com/blog/other-article/', clicks: 0, impressions: 40, avgPosition: 9.1 },
    ]);
    assert.equal(winner, 'https://example.com/blog/top-ai-companies-nepal-2026/');
    assert.deepEqual(losers, ['https://example.com/blog/other-article/']);
  });

  test('the homepage is penalized against a dedicated page even with more clicks', () => {
    // The homepage often accumulates clicks from unrelated brand/navigation
    // intent, not from genuinely answering this specific query — a dedicated
    // page naming the topic in its own URL is the more defensible owner.
    const { winner } = pickCannibalizationWinner('ai company in nepal', [
      { page: 'https://example.com/', clicks: 5, impressions: 30, avgPosition: 1.0 },
      { page: 'https://example.com/blog/top-ai-companies-nepal-2026/', clicks: 4, impressions: 25, avgPosition: 2.25 },
    ]);
    assert.equal(winner, 'https://example.com/blog/top-ai-companies-nepal-2026/');
  });

  test('URL-slug relevance breaks a near-tie toward the page that actually names the topic', () => {
    const { winner } = pickCannibalizationWinner('booking engine pricing', [
      { page: 'https://example.com/products/ai-booking-engine/', clicks: 3, impressions: 20, avgPosition: 4.0 },
      { page: 'https://example.com/blog/general-comparison-guide/', clicks: 3, impressions: 20, avgPosition: 4.0 },
    ]);
    assert.equal(winner, 'https://example.com/products/ai-booking-engine/');
  });

  test('is stable regardless of input order (ties break on clicks, then path length, then alphabetically)', () => {
    const pages = [
      { page: 'https://example.com/b', clicks: 1, impressions: 10, avgPosition: 5 },
      { page: 'https://example.com/a', clicks: 1, impressions: 10, avgPosition: 5 },
    ];
    const forward = pickCannibalizationWinner('x', pages);
    const reversed = pickCannibalizationWinner('x', [...pages].reverse());
    assert.equal(forward.winner, reversed.winner);
  });

  test('never invents a page not present in the input', () => {
    const pages = [
      { page: 'https://example.com/a', clicks: 5, impressions: 50, avgPosition: 2 },
      { page: 'https://example.com/b', clicks: 1, impressions: 5, avgPosition: 8 },
    ];
    const { winner, losers, scoring } = pickCannibalizationWinner('x', pages);
    const known = new Set(pages.map((p) => p.page));
    assert.ok(known.has(winner));
    for (const l of losers) assert.ok(known.has(l));
    assert.equal(scoring.length, pages.length);
  });
});
