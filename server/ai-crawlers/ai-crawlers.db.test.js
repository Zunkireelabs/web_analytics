import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';

// Stage 2 against a REAL Postgres: the upload endpoint, the per-project separation, retention, the table rules and the vendor
// list cache. The SQL here (upserts, CHECKs, cascades) is exactly what a fake database cannot prove.
//
// SAFETY: this file writes and deletes rows, so it only runs against a database on THIS machine (localhost / 127.0.0.1) that
// already has migration 250. Anywhere else (CI without a database, a laptop pointed at a remote database) it skips with a
// message; it can never touch a shared or production database. Run it locally with the throwaway dev database:
//   DATABASE_URL=postgres://postgres:dev@localhost:55432/analytics DB_SSL=off node --test server/ai-crawlers/

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
const isLocal = (() => { try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(process.env.DATABASE_URL).hostname); } catch { return false; } })();

const { query, pool, createClientSite, suspendSite } = await import('../db.js');
const store = await import('../store/ai-crawlers.js');
const { createCrawlerIngestRouter, MAX_BODY_BYTES, loadSiteSummary, loadClientComparison } = await import('../routes/ai-crawlers.js');
const { getRanges, forgetRangesMemo, staleListIds, MAX_AGE_MS, RETRY_AFTER_MS } = await import('./ranges-cache.js');
const { compileRanges, parseRangesJson, verifyVisit, LIST_URLS } = await import('./verify.js');
const { botById } = await import('./bots.js');
const { REAL_BOT, REAL_META, SEARCHBOT_JSON, ANTHROPIC_JSON } = await import('./fixtures.js');

let skipReason = null;
if (!isLocal) skipReason = 'DATABASE_URL is not a local database';
else {
  try {
    await Promise.race([query('SELECT 1 FROM ai_crawler_visits_daily LIMIT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
  } catch (err) { skipReason = `no local Postgres with migration 250 (${err.code || err.message})`; }
}
if (skipReason) console.log(`# ai-crawlers.db.test.js skipped: ${skipReason}`);

const ranges = compileRanges({ 'openai-searchbot': parseRangesJson(SEARCHBOT_JSON) });
const rand = crypto.randomBytes(4).toString('hex');
const siteIds = [];
const newSite = async (label) => {
  const s = await createClientSite({ name: `crawler-test-${label}-${rand}`, websiteDomain: `${label.toLowerCase()}-${rand}.test`, timezone: 'UTC', propertyType: 'website' });
  siteIds.push(s.id);
  return s;
};
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const appWith = (opts) => {
  const app = express();
  app.use('/api', createCrawlerIngestRouter({ getRangesFn: async () => ranges, ...opts }));
  app.use((err, req, res, next) => res.status(500).json({ error: String(err.message) })); // eslint-disable-line no-unused-vars
  return app;
};
const sum = (rows) => rows.reduce((n, r) => n + r.hits, 0);
const WIDE = ['2000-01-01', '2100-01-01'];

describe('AI crawler analytics on a real database', { skip: skipReason || false }, () => {
  let A, B, tokenA, tokenB, server, base;
  const post = async (token, body, { search = '', headers = {} } = {}) => {
    const res = await fetch(`${base}/api/ai-crawlers/ingest${search}`, {
      method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'text/plain', ...headers }, body,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  before(async () => {
    A = await newSite('A'); B = await newSite('B');
    tokenA = await store.createCrawlerToken(A.id, { label: 'test A' });
    tokenB = await store.createCrawlerToken(B.id, { label: 'test B' });
    server = await listen(appWith());
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await query('DELETE FROM agent_instances WHERE site_id = ANY($1::int[])', [siteIds]).catch(() => {});
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
    // The list-cache tests leave fake lists and fake "HTTP 503" attempts behind; a real app run against this database must not inherit them.
    await query('DELETE FROM ai_crawler_ip_lists');
    await pool.end();
  });

  describe('who may upload', () => {
    test('no token, a wrong token and garbage are all 401 and write nothing', async () => {
      assert.equal((await post(null, REAL_BOT)).status, 401);
      assert.equal((await post('acr_' + 'f'.repeat(64), REAL_BOT)).status, 401);
      assert.equal((await post('short', REAL_BOT)).status, 401);
      assert.equal((await post('x'.repeat(500), REAL_BOT)).status, 401);
      assert.equal((await post(tokenA.token, REAL_BOT, { headers: { Authorization: `Basic ${tokenA.token}` } })).status, 401);
      assert.deepEqual(await store.getCrawlerRows(A.id, ...WIDE), []);
    });
    test('a revoked token stops working at once', async () => {
      const t = await store.createCrawlerToken(A.id, { label: 'to revoke' });
      assert.equal((await post(t.token, '')).status, 200);
      assert.equal(await store.revokeCrawlerToken(A.id, t.id), true);
      assert.equal((await post(t.token, '')).status, 401);
      assert.equal(await store.revokeCrawlerToken(A.id, t.id), false, 'revoking twice reports nothing to revoke');
    });
    test("one project cannot revoke another project's token", async () => {
      assert.equal(await store.revokeCrawlerToken(B.id, tokenA.id), false);
      assert.equal((await post(tokenA.token, '')).status, 200);
    });
    test('only a hash of the token is stored', async () => {
      const { rows } = await query('SELECT row_to_json(t)::text AS j FROM ai_crawler_tokens t WHERE id = $1', [tokenA.id]);
      assert.equal(rows[0].j.includes(tokenA.token), false);
      assert.match(rows[0].j, /"token_hash":"[0-9a-f]{64}"/);
    });
    test('an inactive project cannot upload', async () => {
      const C = await newSite('C');
      const t = await store.createCrawlerToken(C.id);
      assert.equal((await post(t.token, REAL_BOT)).status, 200);
      await suspendSite(C.id);
      assert.equal((await post(t.token, REAL_BOT.replace(':09 ', ':10 '))).status, 403);
    });
  });

  describe('one project never sees or receives another project\'s data', () => {
    test('counts land under the token\'s project only', async () => {
      const r = await post(tokenA.token, [REAL_BOT, REAL_META].join('\n'));
      assert.equal(r.status, 200);
      assert.equal(r.json.visits, 2);
      const a = await store.getCrawlerRows(A.id, ...WIDE);
      assert.deepEqual(a.map((x) => [x.botId, x.verification, x.hits]), [['meta-webindexer', 'unchecked', 1], ['oai-searchbot', 'verified', 1]]);
      assert.deepEqual(await store.getCrawlerRows(B.id, ...WIDE), []);
      const { rows } = await query('SELECT count(*)::int AS n FROM ai_crawler_visits_daily WHERE site_id = $1', [B.id]);
      assert.equal(rows[0].n, 0);
    });
    test('naming another project in the URL, headers or body changes nothing', async () => {
      const before = sum(await store.getCrawlerRows(A.id, ...WIDE));
      const line = REAL_BOT.replace('19:28:09', '19:28:10');
      const r = await post(tokenA.token, `${line}\n{"site_id": ${B.id}, "siteId": ${B.id}}`, {
        search: `?site_id=${B.id}&siteId=${B.id}&project=${B.id}`,
        headers: { 'X-Site-Id': String(B.id), 'X-Project-Id': String(B.id), Host: `b-${rand}.test` },
      });
      assert.equal(r.status, 200);
      assert.equal(sum(await store.getCrawlerRows(A.id, ...WIDE)), before + 1);
      assert.deepEqual(await store.getCrawlerRows(B.id, ...WIDE), []);
    });
    test("B's token writes B's data and A's data is untouched", async () => {
      const aBefore = JSON.stringify(await store.getCrawlerRows(A.id, ...WIDE));
      const r = await post(tokenB.token, REAL_META.replace('/blog/robots', '/b-only/robots'));
      assert.equal(r.status, 200);
      const b = await store.getCrawlerRows(B.id, ...WIDE);
      assert.equal(b.length, 1);
      assert.match(b[0].path, /^\/b-only\//);
      assert.equal(JSON.stringify(await store.getCrawlerRows(A.id, ...WIDE)), aBefore);
      assert.equal((await store.getCrawlerRows(A.id, ...WIDE)).some((x) => x.path.startsWith('/b-only')), false);
    });
    test('the same bot, path, day and status in two projects are two separate rows', async () => {
      const line = REAL_BOT.replace('/robots.txt', '/shared-path');
      await post(tokenA.token, line); await post(tokenB.token, line);
      const a = (await store.getCrawlerRows(A.id, ...WIDE)).find((x) => x.path === '/shared-path');
      const b = (await store.getCrawlerRows(B.id, ...WIDE)).find((x) => x.path === '/shared-path');
      assert.equal(a.hits, 1); assert.equal(b.hits, 1);
    });
    test('deleting a project deletes its counts, batches and tokens, and nobody else\'s', async () => {
      const D = await newSite('D');
      const t = await store.createCrawlerToken(D.id);
      await post(t.token, REAL_BOT.replace('/robots.txt', '/d-page'));
      const count = async (table, id) => (await query(`SELECT count(*)::int AS n FROM ${table} WHERE site_id = $1`, [id])).rows[0].n;
      assert.equal(await count('ai_crawler_visits_daily', D.id), 1);
      assert.equal(await count('ai_crawler_batches', D.id), 1);
      const aRows = (await store.getCrawlerRows(A.id, ...WIDE)).length;
      await query('DELETE FROM agent_instances WHERE site_id = $1', [D.id]).catch(() => {});
      await query('DELETE FROM sites WHERE id = $1', [D.id]);
      for (const table of ['ai_crawler_visits_daily', 'ai_crawler_batches', 'ai_crawler_tokens']) assert.equal(await count(table, D.id), 0, table);
      assert.equal((await store.getCrawlerRows(A.id, ...WIDE)).length, aRows);
    });
  });

  describe('counting', () => {
    test('the same batch sent twice (a retry) is counted once', async () => {
      const line = REAL_BOT.replace('/robots.txt', '/retry-page');
      const first = await post(tokenA.token, line);
      const second = await post(tokenA.token, line);
      assert.equal(first.json.duplicate, false);
      assert.equal(second.json.duplicate, true);
      assert.equal(second.json.visits, 0);
      assert.equal((await store.getCrawlerRows(A.id, ...WIDE)).find((x) => x.path === '/retry-page').hits, 1);
    });
    test('a different batch for the same day, bot, path and status adds to the count', async () => {
      const mk = (sec) => REAL_BOT.replace('/robots.txt', '/adds-up').replace('19:28:09', `19:28:${sec}`);
      await post(tokenA.token, mk('11')); await post(tokenA.token, `${mk('12')}\n${mk('13')}`);
      assert.equal((await store.getCrawlerRows(A.id, ...WIDE)).find((x) => x.path === '/adds-up').hits, 3);
    });
    test('a fake crawler (right user agent, wrong address) is stored as unverified', async () => {
      const fake = '172.18.0.3 - - [17/Nov/2026:19:00:00 +0000] "GET /fake-page HTTP/1.1" 200 5 "-" "Mozilla/5.0; compatible; OAI-SearchBot/1.0" "8.8.8.8"';
      const r = await post(tokenA.token, fake);
      assert.deepEqual(r.json.byVerification, { verified: 0, unverified: 1, unchecked: 0 });
      assert.equal((await store.getCrawlerRows(A.id, ...WIDE)).find((x) => x.path === '/fake-page').verification, 'unverified');
    });
    test('nothing in the stored rows or the response is a visitor address', async () => {
      const r = await post(tokenA.token, REAL_BOT.replace('/robots.txt', '/no-ip-check'));
      const stored = await query(`SELECT row_to_json(t)::text AS j FROM ai_crawler_visits_daily t WHERE site_id = $1
                                  UNION ALL SELECT row_to_json(b)::text FROM ai_crawler_batches b WHERE site_id = $1`, [A.id]);
      const everything = stored.rows.map((x) => x.j).join('\n') + JSON.stringify(r.json);
      assert.equal(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(everything), false);
      assert.equal(everything.includes('Mozilla'), false, 'no user agent stored either');
    });
    test('an empty upload is accepted, records nothing, and still shows the script is alive', async () => {
      const before = (await store.listCrawlerTokens(A.id)).find((t) => t.id === tokenA.id).last_used_at;
      await new Promise((r) => setTimeout(r, 15));
      const r = await post(tokenA.token, '   \n');
      assert.equal(r.status, 200); assert.equal(r.json.visits, 0);
      const after = (await store.listCrawlerTokens(A.id)).find((t) => t.id === tokenA.id).last_used_at;
      assert.ok(after > before, 'last_used_at moved forward');
    });
    test('only non-bot, unreadable and own-agent lines: accepted, zero visits, reported as skipped', async () => {
      const own = '172.18.0.3 - - [18/Nov/2026:01:31:49 +0000] "GET / HTTP/1.1" 200 5 "-" "Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0)" "172.18.0.1"';
      const human = '172.18.0.3 - - [18/Nov/2026:01:31:49 +0000] "GET / HTTP/1.1" 200 5 "-" "Mozilla/5.0 Chrome/131" "203.0.113.9"';
      const r = await post(tokenA.token, [own, human, 'garbage'].join('\n'));
      assert.deepEqual(r.json.skipped, { unreadable: 1, notAiCrawler: 1, ownAgents: 1 });
      assert.equal(r.json.visits, 0);
    });
  });

  describe('limits', () => {
    test('an upload over 5 MB is refused with a clear JSON answer, not an HTML error page', async () => {
      const r = await post(tokenA.token, 'x'.repeat(MAX_BODY_BYTES + 1000));
      assert.equal(r.status, 413);
      assert.match(r.json.error, /smaller batches/);
    });
    test('more than 100,000 lines is refused', async () => {
      const r = await post(tokenA.token, 'x\n'.repeat(100_001));
      assert.equal(r.status, 413);
    });
    test('the daily distinct-path cap holds across separate uploads, and totals stay exact', async () => {
      const C = await newSite('Cap');
      const t = await store.createCrawlerToken(C.id);
      const small = await listen(appWith({ maxPathsPerDay: 3 }));
      try {
        const url = `http://127.0.0.1:${small.address().port}/api/ai-crawlers/ingest`;
        const send = (body) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${t.token}` }, body }).then((r) => r.json());
        const line = (p, sec) => REAL_BOT.replace('/robots.txt', p).replace('19:28:09', `19:28:${String(sec).padStart(2, '0')}`);
        await send([line('/p1', 1), line('/p2', 2)].join('\n'));                       // 2 paths used
        await send([line('/p3', 3), line('/p4', 4), line('/p5', 5)].join('\n'));       // only /p3 fits; /p4 and /p5 fold
        await send([line('/p1', 6), line('/p6', 7)].join('\n'));                       // an existing path keeps its own row; /p6 folds
        const rows = await store.getCrawlerRows(C.id, ...WIDE);
        assert.deepEqual(rows.map((r) => r.path).sort(), ['(other)', '/p1', '/p2', '/p3']);
        assert.equal(rows.find((r) => r.path === '/p1').hits, 2);
        assert.equal(rows.find((r) => r.path === '(other)').hits, 3);
        assert.equal(sum(rows), 7);
      } finally { await new Promise((r) => small.close(r)); }
    });
  });

  describe('retention', () => {
    test('counts older than 13 months are deleted for every project, newer ones kept; old batch records go after 14 days', async () => {
      const ins = (siteId, day, path) => query(
        `INSERT INTO ai_crawler_visits_daily (site_id, day, bot_id, path, status, verification, hits)
         VALUES ($1, (now() AT TIME ZONE 'UTC')::date - $2::int, 'gptbot', $3, 200, 'verified', 1)`, [siteId, day, path]);
      await ins(A.id, 14 * 31, '/ret-too-old-A'); await ins(B.id, 14 * 31, '/ret-too-old-B');
      await ins(A.id, 12 * 28, '/ret-keep-A'); await ins(B.id, 1, '/ret-keep-B');
      await query(`INSERT INTO ai_crawler_batches (site_id, batch_hash, received_at) VALUES ($1, 'old-batch-${rand}', now() - interval '15 days'), ($1, 'new-batch-${rand}', now() - interval '2 days')`, [A.id]);
      const res = await store.pruneCrawlerData();
      assert.ok(res.countsDeleted >= 2 && res.batchesDeleted >= 1);
      const paths = async (id) => (await store.getCrawlerRows(id, ...WIDE)).map((r) => r.path);
      assert.equal((await paths(A.id)).includes('/ret-too-old-A'), false);
      assert.equal((await paths(B.id)).includes('/ret-too-old-B'), false);
      assert.equal((await paths(A.id)).includes('/ret-keep-A'), true);
      assert.equal((await paths(B.id)).includes('/ret-keep-B'), true);
      const batches = (await query('SELECT batch_hash FROM ai_crawler_batches WHERE site_id = $1', [A.id])).rows.map((r) => r.batch_hash);
      assert.equal(batches.includes(`old-batch-${rand}`), false);
      assert.equal(batches.includes(`new-batch-${rand}`), true);
    });
  });

  describe('table rules', () => {
    const bad = (label, values) => test(`the database refuses ${label}`, async () => {
      await assert.rejects(query(
        `INSERT INTO ai_crawler_visits_daily (site_id, day, bot_id, path, status, verification, hits) VALUES ($1, '2026-11-01', 'gptbot', $2, $3, $4, $5)`,
        [A.id, values.path ?? '/ok', values.status ?? 200, values.verification ?? 'verified', values.hits ?? 1]), /violates check constraint|violates not-null/);
    });
    bad('an invented verification value', { verification: 'maybe' });
    bad('zero hits', { hits: 0 });
    bad('a path over 200 characters', { path: '/' + 'x'.repeat(250) });
    bad('a status that is not an HTTP status', { status: 99 });
    test('the database refuses a row for a project that does not exist', async () => {
      await assert.rejects(query(`INSERT INTO ai_crawler_visits_daily (site_id, day, bot_id, path, status, verification, hits) VALUES (2147483000, '2026-11-01', 'gptbot', '/x', 200, 'verified', 1)`), /foreign key/);
    });
  });

  describe('vendor IP list cache', () => {
    const fetchFor = (log, { fail = [] } = {}) => async (url) => {
      log.push(url);
      if (fail.includes(url)) return { ok: false, status: 503, text: async () => '' };
      return { ok: true, status: 200, text: async () => (url === LIST_URLS.anthropic ? ANTHROPIC_JSON : SEARCHBOT_JSON) };
    };
    const reset = async () => { await query('DELETE FROM ai_crawler_ip_lists'); forgetRangesMemo(); };
    const T0 = Date.parse('2026-11-18T08:00:00Z');

    test('an empty cache fetches every list once and stores them; verification then works', async () => {
      await reset();
      const log = [];
      const r = await getRanges({ now: T0, fetchImpl: fetchFor(log), useMemo: false });
      assert.equal(log.length, Object.keys(LIST_URLS).length);
      assert.equal((await store.loadIpListCache()).length, Object.keys(LIST_URLS).length);
      assert.equal(verifyVisit(botById('oai-searchbot'), '51.8.102.237', r), 'verified');
      assert.equal(verifyVisit(botById('claudebot'), '216.73.217.5', r), 'verified');
    });
    test('within a day it does not fetch again; after a day it does', async () => {
      await reset(); const log = [];
      await getRanges({ now: T0, fetchImpl: fetchFor(log), useMemo: false });
      const n = log.length;
      await getRanges({ now: T0 + 3600e3, fetchImpl: fetchFor(log), useMemo: false });
      assert.equal(log.length, n, 'no refetch after 1 hour');
      await getRanges({ now: T0 + MAX_AGE_MS + 60e3, fetchImpl: fetchFor(log), useMemo: false });
      assert.equal(log.length, 2 * n, 'refetched after a day');
    });
    test('a failed refresh KEEPS the last good list, so real crawlers are not turned into "unverified"', async () => {
      await reset(); const log = [];
      await getRanges({ now: T0, fetchImpl: fetchFor(log), useMemo: false });
      const down = fetchFor(log, { fail: Object.values(LIST_URLS) });
      const r = await getRanges({ now: T0 + MAX_AGE_MS + 60e3, fetchImpl: down, useMemo: false });
      assert.equal(verifyVisit(botById('oai-searchbot'), '51.8.102.237', r), 'verified');
      const row = (await store.loadIpListCache()).find((x) => x.list_id === 'openai-searchbot');
      assert.match(row.last_error, /HTTP 503/);
      assert.ok(row.cidrs.length > 0);
    });
    test('a list that has never loaded gives "unchecked", never "unverified"', async () => {
      await reset();
      const r = await getRanges({ now: T0, fetchImpl: fetchFor([], { fail: Object.values(LIST_URLS) }), useMemo: false });
      assert.equal(r.has('openai-searchbot'), false);
      assert.equal(verifyVisit(botById('oai-searchbot'), '8.8.8.8', r), 'unchecked');
    });
    test('a list that failed is not retried for 30 minutes, then is', async () => {
      await reset(); const log = [];
      const down = fetchFor(log, { fail: Object.values(LIST_URLS) });
      await getRanges({ now: T0, fetchImpl: down, useMemo: false });
      const n = log.length;
      await getRanges({ now: T0 + 10 * 60e3, fetchImpl: down, useMemo: false });
      assert.equal(log.length, n, 'no retry after 10 minutes');
      await getRanges({ now: T0 + RETRY_AFTER_MS + 60e3, fetchImpl: down, useMemo: false });
      assert.equal(log.length, 2 * n, 'retried after 30 minutes');
    });
    test('the cache table is the only thing that is shared between projects: it holds public vendor lists, no project data', async () => {
      const cols = (await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_crawler_ip_lists'`)).rows.map((r) => r.column_name);
      assert.equal(cols.includes('site_id'), false);
    });
    test('staleListIds is pure and honours both rules', () => {
      const t = T0;
      const ids = Object.keys(LIST_URLS);
      assert.deepEqual(staleListIds([], t), ids);
      const fresh = ids.map((id) => ({ list_id: id, fetched_at: new Date(t - 3600e3), last_attempt_at: new Date(t - 3600e3), last_error: null }));
      assert.deepEqual(staleListIds(fresh, t), []);
      const old = fresh.map((r) => ({ ...r, fetched_at: new Date(t - MAX_AGE_MS - 1000) }));
      assert.deepEqual(staleListIds(old, t), ids);
      const triedJustNow = old.map((r) => ({ ...r, last_attempt_at: new Date(t - 60e3), last_error: 'HTTP 503' }));
      assert.deepEqual(staleListIds(triedJustNow, t), []);
      const triedInTheFuture = old.map((r) => ({ ...r, last_attempt_at: new Date(t + 5 * 3600e3), last_error: 'HTTP 503' }));
      assert.deepEqual(staleListIds(triedInTheFuture, t), ids, 'a last-tried time in the future does not block a retry');
    });
  });
  describe('dashboard numbers (Stage 3)', () => {
    const today = new Date().toISOString().slice(0, 10);
    test('a project\'s summary holds only its own visits, and the staff comparison keeps every client apart', async () => {
      const a = await newSite('DashA'); const b = await newSite('DashB');
      await store.saveCrawlerBatch(a.id, { batchHash: `dash-a-${rand}`, rows: [{ day: today, botId: 'gptbot', path: '/only-a', status: 200, verification: 'verified', hits: 7 }] });
      await store.saveCrawlerBatch(b.id, { batchHash: `dash-b-${rand}`, rows: [{ day: today, botId: 'gptbot', path: '/only-b', status: 200, verification: 'verified', hits: 3 }] });
      const sa = await loadSiteSummary(a.id, 28); const sb = await loadSiteSummary(b.id, 28);
      assert.equal(sa.totals.visits, 7); assert.equal(sb.totals.visits, 3);
      assert.deepEqual(sa.crawlers[0].pages.map((p) => p.path), ['/only-a']);
      assert.equal(JSON.stringify(sa).includes('only-b'), false);
      const cmp = await loadClientComparison(28);
      assert.equal(cmp.clients.find((c) => c.siteId === a.id).visits, 7);
      assert.equal(cmp.clients.find((c) => c.siteId === b.id).visits, 3);
      assert.equal(cmp.clients.find((c) => c.siteId === a.id).connected, false, 'no token created, so not connected');
    });
    test('a project with no data gets zeros, not an error', async () => {
      const c = await newSite('DashC');
      const s = await loadSiteSummary(c.id, 7);
      assert.equal(s.totals.visits, 0); assert.equal(s.daily.length, 7); assert.equal(s.status.trackingSince, null);
    });
  });
});
