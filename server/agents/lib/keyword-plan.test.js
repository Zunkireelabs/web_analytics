import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  recommendPlanForGap, estimatePotentialImpressions, buildHaveKeywords, buildKeywordsOverview,
  buildPagesOverview, isSkippablePage, industryOf, normalizePageUrl,
} from './keyword-plan.js';

describe('recommendPlanForGap', () => {
  test('ready-to-buy search on what the site sells is a landing page', () => {
    assert.equal(recommendPlanForGap({ search_intent: 'commercial', product_relevance: 'direct' }).plan, 'landing');
    assert.equal(recommendPlanForGap({ search_intent: 'transactional', product_relevance: 'direct' }).plan, 'landing');
  });
  test('a learning search, or a commercial one that is not a direct match, is a blog post', () => {
    assert.equal(recommendPlanForGap({ search_intent: 'informational', product_relevance: 'direct' }).plan, 'blog');
    assert.equal(recommendPlanForGap({ search_intent: 'commercial', product_relevance: 'supporting' }).plan, 'blog');
  });
  test('an unclassified keyword defaults to a blog post, never a landing page', () => {
    assert.equal(recommendPlanForGap({}).plan, 'blog');
  });
  test('what a page already covers, or what is unrelated, is just tracked', () => {
    assert.equal(recommendPlanForGap({ existing_page_match: 'https://x.test/a' }).plan, 'track');
    assert.equal(recommendPlanForGap({ coverage_status: 'duplicate' }).plan, 'track');
    assert.equal(recommendPlanForGap({ search_intent: 'informational', product_relevance: 'unrelated' }).plan, 'track');
  });
  test('every recommendation carries a reason in plain words', () => {
    for (const g of [{}, { search_intent: 'commercial', product_relevance: 'direct' }, { existing_page_match: 'x' }]) {
      assert.ok(recommendPlanForGap(g).reason.length > 20);
    }
  });
});

describe('estimatePotentialImpressions', () => {
  test('is a quarter of the monthly searches, rounded to ten, and null without a volume', () => {
    assert.equal(estimatePotentialImpressions(4400), 1100);
    assert.equal(estimatePotentialImpressions(720), 180);
    assert.equal(estimatePotentialImpressions(null), null);
    assert.equal(estimatePotentialImpressions(0), null);
    assert.equal(estimatePotentialImpressions('abc'), null);
  });
});

const rows = [
  { query: 'AI SEO agent', page: 'https://x.test/', clicks: 40, impressions: 2000, avgPosition: 11 },
  { query: 'ai seo agent', page: 'https://x.test/pricing', clicks: 4, impressions: 400, avgPosition: 13 },
  { query: 'what is llms.txt', page: 'https://x.test/blog/llms', clicks: 61, impressions: 1000, avgPosition: 3 },
];

describe('buildHaveKeywords', () => {
  test('a keyword on two pages is one keyword: totals, the page that earns most, a weighted position', () => {
    const have = buildHaveKeywords(rows);
    assert.equal(have.length, 2);
    const k = have.find((h) => h.keyword === 'ai seo agent');
    assert.equal(k.impressions, 2400);
    assert.equal(k.clicks, 44);
    assert.equal(k.page, 'https://x.test/');
    assert.equal(k.pageCount, 2);
    assert.equal(k.position, 11.3);
  });
  test('sorted by impressions, biggest first', () => {
    assert.deepEqual(buildHaveKeywords(rows).map((h) => h.keyword), ['ai seo agent', 'what is llms.txt']);
  });
  test('nothing in, nothing out', () => {
    assert.deepEqual(buildHaveKeywords([]), []);
    assert.deepEqual(buildHaveKeywords(null), []);
  });
});

describe('buildKeywordsOverview', () => {
  const gaps = [
    { id: 1, topic: 'answer engine optimization', status: 'pending_review', search_volume: 4400, reason: 'Fast growing. Close to what you do.', search_intent: 'informational' },
    { id: 2, topic: 'ai seo agent', status: 'pending_review', search_volume: 1300 }, // already ranks, so not "not yet"
    { id: 3, topic: 'llms.txt generator', status: 'pending_review', search_volume: 720, content_plan: 'blog' },
    { id: 4, topic: 'dismissed one', status: 'rejected', search_volume: 9999 },
    { id: 5, topic: 'covered one', status: 'pending_review', coverage_status: 'covered' },
    { id: 6, topic: 'seo reporting template', status: 'pending_review', search_volume: 2900, evidence_snapshots: [{ impressions: 10 }, { impressions: 20 }] },
  ];
  const o = buildKeywordsOverview({ metrics: rows, gaps });

  test('the summary counts what the site has and what is left to go after', () => {
    assert.equal(o.summary.keywords, 2);
    assert.equal(o.summary.pages, 3);
    assert.equal(o.summary.impressions, 3400);
    assert.equal(o.summary.top3, 1);
    assert.equal(o.summary.toGoAfter, 2);
  });
  test('"not yet" leaves out keywords the site ranks for, dismissed ones and covered ones', () => {
    assert.deepEqual(o.notYet.map((r) => r.id).sort(), [1, 3, 6]);
  });
  test('biggest potential first; a decided keyword keeps its place and its plan', () => {
    assert.deepEqual(o.notYet.map((r) => r.id), [1, 6, 3]);
    assert.equal(o.notYet[2].plan, 'blog');
  });
  test('a collected keyword carries what people want and how it fits, for the question after "Go after this"', () => {
    const r = o.notYet.find((x) => x.id === 1);
    assert.equal(r.recommended.plan, 'blog');
    assert.equal(r.recommended.intent, 'informational');
    assert.equal(r.recommended.relevance, null);
  });
  test('potential, trend and a one-sentence reason are filled in', () => {
    const r = o.notYet.find((x) => x.id === 1);
    assert.equal(r.potential, 1100);
    assert.equal(r.why, 'Fast growing.');
    assert.deepEqual(o.notYet.find((x) => x.id === 6).trend, { points: [10, 20], pct: 100 });
    assert.equal(o.notYet.find((x) => x.id === 3).trend, null);
  });
  test('industries are only collected for a product project', () => {
    const caps = [{ industries: ['salons', 'gyms'] }, { industries: ['gyms', 'wellness'] }];
    assert.deepEqual(buildKeywordsOverview({ gaps, capabilities: caps, isProduct: false }).industries, []);
    assert.deepEqual(buildKeywordsOverview({ gaps, capabilities: caps, isProduct: true }).industries, ['salons', 'gyms', 'wellness']);
  });
});

describe('industryOf', () => {
  test('matches a keyword to who the product is sold to, singular or plural', () => {
    assert.equal(industryOf('salon booking software', ['gyms', 'salons']), 'salons');
    assert.equal(industryOf('class booking app for gym', ['gyms', 'salons']), 'gyms');
    assert.equal(industryOf('online scheduling tool', ['gyms', 'salons']), null);
  });
});

describe('pages', () => {
  test('isSkippablePage treats legal and utility pages as not needing keywords', () => {
    for (const p of ['https://x.test/privacy', 'https://x.test/terms/', 'https://x.test/cookie-policy', 'https://x.test/thank-you', 'https://x.test/login', 'https://x.test/tag/seo']) {
      assert.equal(isSkippablePage(p), true, p);
    }
    for (const p of ['https://x.test/', 'https://x.test/blog/seo-for-small-business', 'https://x.test/careers', 'https://x.test/pricing']) {
      assert.equal(isSkippablePage(p), false, p);
    }
  });
  test('normalizePageUrl ignores a trailing slash and host case', () => {
    assert.equal(normalizePageUrl('https://X.test/blog/'), normalizePageUrl('https://x.test/blog'));
  });

  const inventory = [
    { page: 'https://x.test/', first_seen_at: '2026-01-01' },
    { page: 'https://x.test/blog/llms/', first_seen_at: '2026-01-01' },
    { page: 'https://x.test/careers', first_seen_at: '2026-01-01' },
    { page: 'https://x.test/blog/seo-for-small-business', first_seen_at: '2026-10-20' },
    { page: 'https://x.test/privacy', first_seen_at: '2026-01-01' },
    { page: 'https://x.test/terms', first_seen_at: '2026-01-01' },
  ];
  const gaps = [
    { topic: 'seo for small business', status: 'pending_review', search_volume: 500 },
    { topic: 'ai seo jobs', status: 'pending_review', search_volume: 100 },
  ];
  const o = buildPagesOverview({ metrics: rows, inventory, gaps, now: new Date('2026-10-27') });

  test('groups keywords by page, biggest first, with a best position', () => {
    assert.deepEqual(o.pages.map((p) => p.path), ['/', '/blog/llms', '/pricing']);
    assert.equal(o.pages[0].topKeyword, 'ai seo agent');
    assert.equal(o.pages[1].bestPosition, 3);
  });
  test('a trailing slash in the inventory does not make a ranking page look empty', () => {
    assert.equal(o.none.some((n) => n.path === '/blog/llms'), false);
  });
  test('pages with no keywords are listed, legal pages are only counted', () => {
    assert.deepEqual(o.none.map((n) => n.path).sort(), ['/blog/seo-for-small-business', '/careers']);
    assert.equal(o.summary.skipped, 2);
    assert.equal(o.summary.worthFixing, 2);
  });
  test('suggestions come only from real collected keywords that share words with the page', () => {
    assert.deepEqual(o.none.find((n) => n.path === '/blog/seo-for-small-business').suggestions, ['seo for small business']);
    assert.deepEqual(o.none.find((n) => n.path === '/careers').suggestions, []);
  });
  test('the reason differs for a new page', () => {
    assert.match(o.none.find((n) => n.path === '/blog/seo-for-small-business').why, /new page/i);
    assert.match(o.none.find((n) => n.path === '/careers').why, /last 28 days/);
  });
  test('the totals add up', () => {
    assert.equal(o.summary.pagesWithKeywords, 3);
    assert.equal(o.summary.totalPages, 3 + 2 + 2);
    assert.equal(o.summary.top3, 1);
  });
});
