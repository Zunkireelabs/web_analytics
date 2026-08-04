import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// growth-queries.js's import chain reaches server/db.js (via store/read.js,
// store/growth-queries.js, store/ai-recommendation.js, store/page-inventory.js),
// which fails fast at import time if DATABASE_URL is unset — same real,
// intentional safety check every other DB-importing test file in this repo
// works around the same way (see geo-audit.test.js). A placeholder value
// here never actually connects: nothing exercised below issues a real
// query — every test targets the exported pure functions only.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const {
  meta, isNewRow, termOverlap, urlSlugOverlap, findCoveringPage,
} = await import('./growth-queries.js');

describe('growth-queries agent meta', () => {
  test('has correct id', () => {
    assert.equal(meta.id, 'growth-queries');
  });

  test('has category geo', () => {
    assert.equal(meta.category, 'geo');
  });

  test('dataSources are honestly labeled connected/not-connected, never fabricated', () => {
    assert.ok(Array.isArray(meta.dataSources) && meta.dataSources.length > 0);
    for (const ds of meta.dataSources) {
      assert.ok(['connected', 'not-connected'].includes(ds.status));
    }
  });
});

describe('isNewRow', () => {
  test('a fresh insert (first_seen_at === last_seen_at) is new', () => {
    const now = new Date('2026-08-01T00:00:00Z');
    assert.equal(isNewRow({ first_seen_at: now, last_seen_at: now }), true);
  });

  test('an updated existing row (last_seen_at bumped, first_seen_at unchanged) is not new', () => {
    assert.equal(isNewRow({
      first_seen_at: new Date('2026-07-01T00:00:00Z'),
      last_seen_at: new Date('2026-08-01T00:00:00Z'),
    }), false);
  });

  test('a null/undefined row is never new', () => {
    assert.equal(isNewRow(null), false);
    assert.equal(isNewRow(undefined), false);
  });
});

describe('termOverlap', () => {
  test('every real term present scores 1', () => {
    assert.equal(termOverlap('the best travel analytics dashboard for hotels', 'travel analytics dashboard'), 1);
  });

  test('no real term present scores 0', () => {
    assert.equal(termOverlap('a page about something else entirely', 'travel analytics dashboard'), 0);
  });

  test('partial term presence scores proportionally', () => {
    const overlap = termOverlap('travel booking software', 'travel analytics dashboard');
    assert.ok(overlap > 0 && overlap < 1);
  });

  test('short (<=2 char) query terms are ignored so common words don\'t inflate the score', () => {
    // "is" and "a" are both <=2 chars and dropped — only "geo" is a real term here.
    assert.equal(termOverlap('a real page about geo visibility', 'is a geo'), 1);
  });
});

describe('urlSlugOverlap', () => {
  test('a URL whose path words match the query scores high', () => {
    assert.ok(urlSlugOverlap('https://example.com/blog/travel-analytics-guide', 'travel analytics') > 0.5);
  });

  test('an unrelated path scores 0', () => {
    assert.equal(urlSlugOverlap('https://example.com/about-us', 'travel analytics dashboard'), 0);
  });

  test('a malformed URL never throws', () => {
    assert.doesNotThrow(() => urlSlugOverlap('not a real url', 'travel analytics'));
  });
});

describe('findCoveringPage', () => {
  const fakeAnalysisFor = (pages) => async (url) => {
    const page = pages[url];
    return page ? { ok: true, analysis: page } : { ok: false };
  };

  test('a page whose real content strongly matches the query is "covered"', async () => {
    const pages = {
      'https://example.com/travel-analytics': { title: 'Travel Analytics Dashboard', metaDescription: 'A real travel analytics dashboard for hotels', bodyText: 'travel analytics dashboard hotels' },
    };
    const result = await findCoveringPage('travel analytics dashboard', 'https://example.com/travel-analytics', [], fakeAnalysisFor(pages));
    assert.equal(result.coverageStatus, 'covered');
    assert.equal(result.page, 'https://example.com/travel-analytics');
  });

  test('a topically-adjacent page with partial overlap is "partial"', async () => {
    // Query has 4 real terms (travel/analytics/dashboard/pricing); this page
    // only really covers 2 of them (travel/dashboard) — 0.5 overlap, inside
    // the partial band (>= 0.34, < 0.75).
    const pages = {
      'https://example.com/travel-tips': { title: 'Travel Dashboard', metaDescription: 'A travel dashboard for hotels', bodyText: 'travel dashboard for hotels' },
    };
    const result = await findCoveringPage('travel analytics dashboard pricing', 'https://example.com/travel-tips', [], fakeAnalysisFor(pages));
    assert.equal(result.coverageStatus, 'partial');
  });

  test('no matching page at all is "missing"', async () => {
    const result = await findCoveringPage('travel analytics dashboard', null, [], fakeAnalysisFor({}));
    assert.equal(result.coverageStatus, 'missing');
    assert.equal(result.page, null);
  });

  test('a page that fails to fetch is skipped, not crashed on', async () => {
    const result = await findCoveringPage('travel analytics', 'https://example.com/broken', [], async () => ({ ok: false }));
    assert.equal(result.coverageStatus, 'missing');
  });
});
