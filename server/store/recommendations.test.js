import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// Regression test for the compound-key mismatch fixed in
// closeStaleRecommendations: recommendationPageKey() (recommendation-
// coordinator.js) stores broken-link-fix rows as `${sourcePage}::${href}`,
// but linkCrawlCheckedKeys (built in agents/lib/recommendations.js from
// technical-seo.js's link crawl) only ever holds bare source-page URLs.
// Comparing the whole compound r.page against that set can never match, so
// a genuinely re-verified-clean broken-link-fix recommendation could never
// auto-supersede — confirmed against real production data (recommendations
// 1426-1431 for zunkireelabs-web, created after the underlying links were
// already stripped from src/pages/index.njk in PR #44).
let rows;
let updated;

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  if (sql.startsWith("SELECT id, page, recommendation_type, detecting_agents FROM recommendations")) {
    return { rows };
  }
  if (sql.startsWith("UPDATE recommendations SET status = 'superseded'")) {
    updated = params[0];
    return { rows: [] };
  }
  throw new Error(`recommendations.test.js fake query: unhandled SQL shape: ${sql}`);
}

mock.module('/Users/yukta/Travel/analytics/server/db.js', {
  namedExports: { query: (text, params) => fakeQuery(text, params) },
});
const { closeStaleRecommendations } = await import('./recommendations.js');

describe('closeStaleRecommendations — broken-link-fix key matching', () => {
  test('supersedes a broken-link-fix row once its source page is re-crawled and the link is gone', async () => {
    rows = [{
      id: 1426,
      page: 'https://www.zunkireelabs.com/::https://www.zunkireelabs.com/solutions/healthcare/',
      recommendation_type: 'broken-link-fix',
      detecting_agents: ['technical-seo'],
    }];
    updated = null;

    const closedCount = await closeStaleRecommendations(1, new Set(), {
      linkCrawlCheckedKeys: new Set(['https://www.zunkireelabs.com/']),
    });

    assert.equal(closedCount, 1);
    assert.deepEqual(updated, [1426]);
  });

  test('leaves a broken-link-fix row open when its source page was not part of this run\'s link crawl', async () => {
    rows = [{
      id: 1426,
      page: 'https://www.zunkireelabs.com/::https://www.zunkireelabs.com/solutions/healthcare/',
      recommendation_type: 'broken-link-fix',
      detecting_agents: ['technical-seo'],
    }];
    updated = null;

    const closedCount = await closeStaleRecommendations(1, new Set(), {
      linkCrawlCheckedKeys: new Set(['https://www.zunkireelabs.com/about/']),
    });

    assert.equal(closedCount, 0);
    assert.equal(updated, null);
  });

  test('stays open (not stale) when the exact recommendation_type::page key is still detected', async () => {
    rows = [{
      id: 1426,
      page: 'https://www.zunkireelabs.com/::https://www.zunkireelabs.com/solutions/healthcare/',
      recommendation_type: 'broken-link-fix',
      detecting_agents: ['technical-seo'],
    }];
    updated = null;

    const stillDetected = new Set([
      "broken-link-fix::https://www.zunkireelabs.com/::https://www.zunkireelabs.com/solutions/healthcare/",
    ]);
    const closedCount = await closeStaleRecommendations(1, stillDetected, {
      linkCrawlCheckedKeys: new Set(['https://www.zunkireelabs.com/']),
    });

    assert.equal(closedCount, 0);
    assert.equal(updated, null);
  });
});
