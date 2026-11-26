// The day-15 keyword evaluation on a real Postgres (the LOCAL throwaway srtest; skipped unless DATABASE_URL points there). Two temporary projects, so tenant isolation is
// part of the test: another project's Search Console numbers for the very same phrase must never count. Search Console rows only, nothing estimated.
//   DB_SSL=off DATABASE_URL=postgres://postgres:<local password>@localhost:55432/srtest node --experimental-test-module-mocks --test server/agents/lib/keyword-schedule.measure.db.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = /@(localhost|127\.0\.0\.1):55432\//.test(process.env.DATABASE_URL || '');

describe('measureKeywordImpressions (day-15 evaluation)', { skip: !LOCAL }, () => {
  let db; let measure; let A; let B; const now = new Date();
  const day = (n) => new Date(now.getTime() + n * 86400000).toISOString().slice(0, 10);
  const kw = async (topic, shippedAt, round = 0, evaluation = null, evaluatedAt = null) => (await db.query(
    `INSERT INTO keyword_gaps (site_id, topic, status, shipped_at, evaluation_round, evaluation, evaluated_at) VALUES ($1, $2, 'accepted', $3, $4, $5, $6) RETURNING id`, [A, topic, shippedAt, round, evaluation, evaluatedAt])).rows[0].id;
  const gsc = (site, q, date, imp, clk, pos) => db.query(`INSERT INTO gsc_query_page (site_id, date, query, page, clicks, impressions, ctr, position, device, country) VALUES ($1, $2, $3, 'https://x.test/p', $4, $5, 0, $6, 'DESKTOP', 'nep')`, [site, date, q, clk, imp, pos]);
  const cleanup = async () => {
    const ids = [A, B].filter(Boolean); if (!ids.length) return;
    for (const t of ['gsc_query_page', 'keyword_gaps', 'recommendations']) await db.query(`DELETE FROM ${t} WHERE site_id = ANY($1::int[])`, [ids]);
    await db.query(`DELETE FROM sites WHERE id = ANY($1::int[])`, [ids]);
  };
  const ids = {};

  before(async () => {
    db = await import('../../db.js'); ({ measureKeywordImpressions: measure } = await import('./keyword-schedule.js'));
    for (const [k, n] of [['A', 'Measure A'], ['B', 'Measure B']]) {
      const { rows } = await db.query(`INSERT INTO sites (name, website_domain, timezone) VALUES ($1, $2, 'UTC') RETURNING id`, [`${n} (measure test)`, `${k}.measure.test`]);
      if (k === 'A') A = rows[0].id; else B = rows[0].id;
    }
    ids.retain = await kw('zzkw retain', day(-20));
    ids.weak = await kw('zzkw weak', day(-20));
    ids.nodata = await kw('zzkw nodata', day(-16));
    ids.replace = await kw('zzkw replace', day(-40), 1, 'improve', day(-20));
    ids.young = await kw('zzkw young', day(-5));
    await gsc(A, 'zzkw retain tips', day(-12), 25, 2, 14); await gsc(A, 'zzkw retain tips', day(-7), 15, 1, 12);
    await gsc(A, 'zzkw weak', day(-7), 3, 0, 60); await gsc(A, 'zzkw replace', day(-7), 2, 0, 70); await gsc(A, 'zzkw young', day(-1), 500, 50, 3);
    await gsc(B, 'zzkw retain tips', day(-8), 9999, 999, 1); // another project's numbers for the same phrase
  });
  after(async () => { await cleanup(); });

  test('verdicts come from this project\'s Search Console rows only', async () => {
    const out = await measure(A, { now });
    assert.equal(out.retained, 1); assert.equal(out.replaced, 1); assert.equal(out.notReady, 1);
    const rows = Object.fromEntries((await db.query(`SELECT topic, impressions_14d i, clicks_14d c, evaluation e, evaluation_round r FROM keyword_gaps WHERE site_id = $1`, [A])).rows.map((r) => [r.topic, r]));
    assert.equal(rows['zzkw retain'].e, 'retain'); assert.equal(rows['zzkw retain'].i, 40); assert.equal(rows['zzkw retain'].c, 3, 'project B\'s 9999 impressions are not counted');
    assert.equal(rows['zzkw weak'].e, 'improve'); assert.equal(rows['zzkw weak'].r, 1);
    assert.equal(rows['zzkw replace'].e, 'replace'); assert.equal(rows['zzkw replace'].r, 2);
    assert.equal(rows['zzkw nodata'].e, null, 'no Search Console data near the end of its window: not judged');
    assert.equal(rows['zzkw young'].e, null, 'shipped 5 days ago: the window is not over');
  });
  test('measuring project B never touches project A\'s keywords', async () => {
    const before = (await db.query(`SELECT count(*)::int n FROM keyword_gaps WHERE site_id = $1 AND evaluated_at IS NOT NULL`, [A])).rows[0].n;
    await measure(B, { now });
    assert.equal((await db.query(`SELECT count(*)::int n FROM keyword_gaps WHERE site_id = $1 AND evaluated_at IS NOT NULL`, [A])).rows[0].n, before);
  });
});
