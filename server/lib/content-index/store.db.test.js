// Real SQL against the LOCAL throwaway database (srtest on the sr-local-pg container, port 55432). Skipped unless DATABASE_URL points there.
//   DB_SSL=off DATABASE_URL=postgres://postgres:<local password>@localhost:55432/srtest node --experimental-test-module-mocks --test server/lib/content-index/store.db.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = /@(localhost|127\.0\.0\.1):55432\//.test(process.env.DATABASE_URL || '');
const SITE = 1;
const MARK = 'content-index-test';

describe('content index against a real Postgres (migration 270)', { skip: !LOCAL }, () => {
  let db; let store; let check;
  const clean = async () => {
    await db.query(`DELETE FROM content_index WHERE site_id = $1`, [SITE]);
    await db.query(`DELETE FROM page_inventory WHERE site_id = $1 AND discovered_via = $2`, [SITE, MARK]);
    await db.query(`DELETE FROM seo_page_snapshots WHERE site_id = $1 AND url LIKE 'https://ci-test.example/%'`, [SITE]);
    await db.query(`DELETE FROM page_content_classification WHERE site_id = $1 AND page LIKE 'https://ci-test.example/%'`, [SITE]);
    await db.query(`DELETE FROM drafts WHERE site_id = $1 AND source = $2`, [SITE, MARK]);
  };
  before(async () => { db = await import('../../db.js'); store = await import('./store.js'); check = await import('./check.js'); await clean(); });
  after(async () => { await clean(); await db.pool?.end?.(); });

  test('refresh builds all five states from the real tables; the check then finds each; a second refresh changes nothing and drops what is gone', async () => {
    const ins = (page) => db.query(`INSERT INTO page_inventory (site_id, page, discovered_via) VALUES ($1, $2, $3)`, [SITE, page, MARK]);
    await ins('https://ci-test.example/best-courses-for-studying-abroad-in-2026'); await ins('https://ci-test.example/contact'); await ins('https://ci-test.example/old-post-removed-later');
    await db.query(`INSERT INTO seo_page_snapshots (site_id, url, title, schema_types) VALUES ($1, 'https://ci-test.example/best-courses-for-studying-abroad-in-2026', 'Best courses for studying abroad in 2026', '["BlogPosting"]')`, [SITE]);
    await db.query(`INSERT INTO page_content_classification (site_id, page, content_type, confidence, classified_by) VALUES ($1, 'https://ci-test.example/old-post-removed-later', 'blog', 0.9, 'llm')`, [SITE]);
    const draft = (status, topic, extra = {}) => db.query(
      `INSERT INTO drafts (site_id, action_type, source, input, content, status, pr_state, pr_url, branch_name, target_file_path) VALUES ($1, 'blog-outline', $2, '{}', $3::jsonb, $4, $5, $6, $7, $8) RETURNING id`,
      [SITE, MARK, JSON.stringify({ topic, title: topic }), status, extra.pr_state || null, extra.pr_url || null, extra.branch || null, extra.file || null]);
    const d1 = (await draft('submitted_for_approval', 'ielts preparation guide')).rows[0].id;
    await draft('approved', 'uk visa interview questions');
    await draft('pr_opened', 'student accommodation london', { pr_state: 'open', pr_url: 'https://github.com/o/r/pull/70', branch: 'action-center/batch-1-2026-11-25', file: 'src/blog/student-accommodation-london.md' });
    await draft('implemented', 'scholarships for nepali students');
    await draft('abandoned', 'part time jobs for students');

    const r1 = await store.refreshContentIndex(SITE);
    const states = (await db.query(`SELECT state, count(*)::int n FROM content_index WHERE site_id = $1 GROUP BY 1 ORDER BY 1`, [SITE])).rows;
    assert.deepEqual(Object.fromEntries(states.map((s) => [s.state, s.n])), { approved: 1, draft: 1, in_pr: 1, merged: 1, published: 3 });
    assert.ok(r1.total >= 7);
    const entries = await store.loadContentIndex(SITE);
    for (const [topic, state] of [['best courses abroad 2026', 'published'], ['ielts preparation guide', 'draft'], ['uk visa interview questions', 'approved'], ['student accommodation in london', 'in_pr'], ['scholarships for nepali students', 'merged']]) {
      const c = check.checkTopicAgainstIndex({ topic, entries }); assert.equal(c.ok, false, topic); assert.equal(c.matches[0].state, state, topic);
    }
    assert.equal(check.checkTopicAgainstIndex({ topic: 'part time jobs for students', entries }).ok, true, 'abandoned does not block');
    assert.equal(check.checkNewPath({ path: 'src/blog/student-accommodation-london.md', entries }).ok, false);
    assert.equal(entries.find((e) => e.url === 'https://ci-test.example/old-post-removed-later').kind, 'blog', 'the classifier cache alone makes it a blog');

    // idempotent, and what disappears from the real sources leaves the index
    await store.refreshContentIndex(SITE);
    assert.equal((await db.query(`SELECT count(*)::int n FROM content_index WHERE site_id = $1`, [SITE])).rows[0].n, r1.total);
    await db.query(`DELETE FROM page_inventory WHERE site_id = $1 AND page LIKE '%old-post-removed-later'`, [SITE]);
    await db.query(`UPDATE drafts SET status = 'abandoned' WHERE id = $1`, [d1]);
    await store.refreshContentIndex(SITE);
    const after = await store.loadContentIndex(SITE);
    assert.ok(!after.some((e) => (e.url || '').endsWith('old-post-removed-later')));
    assert.ok(!after.some((e) => e.draftId === d1));
  });

  test('an entry with no tokens (the home page, a bare path) does not break the refresh for the whole project', async () => {
    await db.query(`INSERT INTO page_inventory (site_id, page, discovered_via) VALUES ($1, 'https://ci-test.example/', $2)`, [SITE, MARK]);
    await store.refreshContentIndex(SITE); // used to fail: NULL into content_index.tokens (NOT NULL), so the index stayed stale for every run
    const rows = await db.query(`SELECT tokens FROM content_index WHERE site_id = $1 AND url = 'https://ci-test.example/'`, [SITE]);
    assert.equal(rows.rows.length, 1);
    assert.deepEqual(rows.rows[0].tokens, []);
  });

  test('getFreshContentIndex refreshes an empty or old index and keeps a fresh one; a failing refresh returns what is stored, flagged stale', async () => {
    await clean();
    const first = await store.getFreshContentIndex(SITE, { maxAgeMs: 60_000 });
    assert.equal(first.stale, false);
    const calls = []; const spy = (sql, p) => { calls.push(sql.slice(0, 30)); return db.query(sql, p); };
    await store.getFreshContentIndex(SITE, { query: spy, maxAgeMs: 60_000 });
    // empty site has 0 rows so it always refreshes; seed one row and prove a fresh index is not rebuilt
    await db.query(`INSERT INTO content_index (site_id, ref_key, state, source) VALUES ($1, 'url:ci-test', 'published', 'test')`, [SITE]);
    calls.length = 0;
    await store.getFreshContentIndex(SITE, { query: spy, maxAgeMs: 60_000 });
    assert.ok(!calls.some((c) => /FROM page_inventory/.test(c)), 'a fresh index is read, not rebuilt');
    const broken = async (sql, p) => { if (/FROM page_inventory/.test(sql)) throw new Error('db hiccup'); return db.query(sql, p); };
    const origErr = console.error; console.error = () => {};
    try {
      await db.query(`UPDATE content_index SET last_seen_at = now() - interval '2 hours' WHERE site_id = $1`, [SITE]);
      const r = await store.getFreshContentIndex(SITE, { query: broken, maxAgeMs: 60_000 });
      assert.equal(r.stale, true); assert.match(r.error, /db hiccup/); assert.equal(r.entries.length, 1);
    } finally { console.error = origErr; }
  });
});
