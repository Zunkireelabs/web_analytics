import { test, describe, mock, beforeEach } from 'node:test';
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
// Every SQL statement this test run issued, so the block-invariant tests
// below can assert on the statement itself rather than only on its result.
let issued;

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  issued.push({ sql, params });
  if (sql.startsWith("SELECT id, page, recommendation_type, detecting_agents FROM recommendations")) {
    return { rows };
  }
  if (sql.startsWith("UPDATE recommendations SET status = 'superseded'")) {
    updated = params[0];
    return { rows: [] };
  }
  if (sql.startsWith('SELECT * FROM recommendations WHERE site_id = $1 AND status =')) {
    return { rows: rows || [] };
  }
  if (sql.startsWith('UPDATE recommendations SET')) {
    return { rows: rows || [] };
  }
  throw new Error(`recommendations.test.js fake query: unhandled SQL shape: ${sql}`);
}

// Resolved relative to this file rather than hardcoded absolute: the old
// '/Users/yukta/...' form only passed from one checkout path on one machine.
const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../db.js'), {
  namedExports: { query: (text, params) => fakeQuery(text, params) },
});
const {
  closeStaleRecommendations, mergeIntoRecommendation, refreshRecommendationBlockState, listOpenSafeRecommendations,
} = await import('./recommendations.js');

beforeEach(() => { issued = []; rows = []; updated = null; });

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

// The block invariant, at the persistence layer.
//
// blocked_reason IS NOT NULL => risk_tier = 'manual'. Migration 108 enforces
// it as a CHECK constraint, and these cover the two write paths that have to
// respect it plus the read path that has to defend against it.
describe('the block invariant at the store layer', () => {
  test('mergeIntoRecommendation writes risk_tier unconditionally, not COALESCE', async () => {
    // risk_tier used to be COALESCE($9, risk_tier) while blocked_reason was
    // written unconditionally. The two express one decision (blockedRiskTier),
    // so a caller passing a fresh block with a falsy tier could leave a stale
    // 'safe' sitting next to a live blocked_reason — exactly the contradiction
    // that took 45 rows out of the shippable set on site 1.
    await mergeIntoRecommendation(7, {
      findingId: 'f1', agentId: 'geo-signals', blockedReason: 'design not verified', riskTier: 'manual',
    });
    const merge = issued.find((q) => q.sql.includes('finding_ids ='));
    assert.ok(merge, 'expected the merge UPDATE to be issued');
    assert.match(merge.sql, /blocked_reason = \$8, risk_tier = \$9/,
      'both fields must be written unconditionally, together');
    assert.doesNotMatch(merge.sql, /risk_tier = COALESCE/);
  });

  test('mergeIntoRecommendation refuses to run without a riskTier', async () => {
    // risk_tier is NOT NULL, so omitting it would surface as a constraint
    // violation deep in the driver, long after the caller left the stack.
    await assert.rejects(
      () => mergeIntoRecommendation(7, { findingId: 'f1', agentId: 'geo-signals', blockedReason: 'x' }),
      /requires riskTier/
    );
  });

  test('refreshRecommendationBlockState writes both fields and bumps last_seen_at', async () => {
    rows = [{ id: 7, risk_tier: 'manual', blocked_reason: 'design not verified' }];
    const result = await refreshRecommendationBlockState(7, { blockedReason: 'design not verified', riskTier: 'manual' });
    const update = issued.find((q) => q.sql.includes('blocked_reason = $2'));
    assert.ok(update, 'expected the refresh UPDATE to be issued');
    assert.match(update.sql, /risk_tier = \$3/);
    assert.match(update.sql, /last_seen_at = now\(\)/, 'we did re-detect the finding this run');
    assert.deepEqual(update.params, [7, 'design not verified', 'manual']);
    assert.equal(result.id, 7);
  });

  test('refreshRecommendationBlockState is a no-op when the state is already correct', async () => {
    // The IS DISTINCT FROM guard means an unchanged block writes nothing, so
    // a sync over thousands of stable recommendations does not churn
    // updated_at on every row every night.
    rows = [];
    const result = await refreshRecommendationBlockState(7, { blockedReason: null, riskTier: 'safe' });
    const update = issued.find((q) => q.sql.includes('blocked_reason = $2'));
    assert.match(update.sql, /IS DISTINCT FROM/);
    assert.equal(result, null, 'no row returned means nothing needed writing');
  });

  test('refreshRecommendationBlockState refuses to run without a riskTier', async () => {
    await assert.rejects(() => refreshRecommendationBlockState(7, { blockedReason: 'x' }), /requires riskTier/);
  });

  test('listOpenSafeRecommendations excludes blocked rows as well as unsafe ones', async () => {
    // Not redundant with risk_tier = 'safe', even though 108 now forbids a row
    // from being both. This is one of the two selectors feeding the unattended
    // path, and the last time this was reasoned about as "the tier already
    // covers it", the tier stopped covering it and nobody noticed for weeks.
    await listOpenSafeRecommendations(1, 30);
    const select = issued.find((q) => q.sql.includes("risk_tier = 'safe'"));
    assert.ok(select, 'expected the safe-recommendation SELECT to be issued');
    assert.match(select.sql, /blocked_reason IS NULL/);
    assert.match(select.sql, /execution_job_id IS NULL/, 'the existing in-flight-job guard must survive');
  });
});
