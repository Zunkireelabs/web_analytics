// The design-protection store and the baseline capture QUEUE against a real Postgres (migration 272). LOCAL ONLY: refuses any database that is not the
// local container on :55432. Run with DB_SSL=off DATABASE_URL=postgres://postgres:<local password>@localhost:55432/srtest
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';

const LOCAL = /@(localhost|127\.0\.0\.1):55432\//.test(process.env.DATABASE_URL || '');
const SITE_A = 990001; const SITE_B = 990002;

describe('design protection store + baseline queue (real local Postgres)', { skip: !LOCAL }, () => {
  let store; let db; let capture; let server; let base;
  const launch = () => chromium.launch({ headless: true, args: ['--no-sandbox'] });
  before(async () => {
    store = await import('./store.js'); db = await import('../../db.js'); capture = await import('../../design-agent/protection/capture-baseline.js');
    for (const id of [SITE_A, SITE_B]) await db.query(`INSERT INTO sites (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, `dp-test-${id}`]);
    await db.query(`DELETE FROM design_baselines WHERE site_id = ANY($1)`, [[SITE_A, SITE_B]]); await db.query(`DELETE FROM design_protection_decisions WHERE site_id = ANY($1)`, [[SITE_A, SITE_B]]);
    const css = '<style>body{font:16px/1.4 Arial,sans-serif;margin:0}.wrap{max-width:700px;margin:0 auto}.post p{font-size:17px;line-height:1.7;color:#222}.post h2{font-size:30px}</style>';
    const p = (n) => `<p>${'Real article text that is long enough to be a body paragraph in the column. '.repeat(n)}</p>`;
    const pg = `<!doctype html><html><head>${css}</head><body><main><article class="wrap"><div class="post">${p(2)}${p(2)}<h2>Heading</h2>${p(2)}${p(2)}</div></article></main></body></html>`;
    server = http.createServer((req, res) => { res.writeHead(req.url.startsWith('/blog/') ? 200 : 404, { 'content-type': 'text/html' }); res.end(pg); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server?.close(); await db.query(`DELETE FROM sites WHERE id = ANY($1)`, [[SITE_A, SITE_B]]); await db.pool?.end?.(); });

  test('requesting is idempotent, and a baseline belongs to ONE project and ONE template', async () => {
    await store.requestBaseline(SITE_A, 'group:g1'); await store.requestBaseline(SITE_A, 'group:g1');
    assert.equal((await db.query(`SELECT count(*)::int n FROM design_baselines WHERE site_id = $1`, [SITE_A])).rows[0].n, 1);
    assert.equal(await store.getBaseline(SITE_B, 'group:g1'), null, 'another project never sees it');
    assert.equal(await store.getBaseline(SITE_A, 'group:other'), null, 'another template never sees it');
    assert.deepEqual([store.baselineUsability(await store.getBaseline(SITE_A, 'group:g1')).usable, store.baselineUsability(await store.getBaseline(SITE_A, 'group:g1')).reason], [false, 'capture-requested']);
  });
  test('a ready baseline is kept by a re-request while fresh; a stale or failed one is re-requested', async () => {
    await store.saveBaseline(SITE_A, 'group:g2', { status: 'ready', tokens: { desktop: {} }, vocabulary: ['a'], patterns: {}, sampleUrls: ['/x'], confidence: 'agreeing-samples' });
    assert.equal((await store.requestBaseline(SITE_A, 'group:g2')).status, 'ready');
    await db.query(`UPDATE design_baselines SET captured_at = now() - interval '60 days' WHERE site_id = $1 AND template_key = 'group:g2'`, [SITE_A]);
    assert.equal((await store.requestBaseline(SITE_A, 'group:g2')).status, 'requested', 'stale => re-requested');
    await store.saveBaseline(SITE_A, 'group:g3', { status: 'failed', error: 'x' }); assert.equal((await store.requestBaseline(SITE_A, 'group:g3')).status, 'requested');
  });
  test('decisions are recorded for pass, block and not-visible, and summarised per project for the log-mode review', async () => {
    for (const [verdict, blocked, would] of [['pass', false, false], ['blocked', false, true], ['not-visible', false, false]]) {
      assert.equal(await store.recordProtectionDecision(SITE_A, { actionType: 'faq', templateKey: 'group:g1', pageUrl: '/blog/b', visible: verdict !== 'not-visible', verdict, mode: 'log', blocked, wouldBlock: would, reasons: [{ code: 'x' }], evidence: { a: 1 } }), true);
    }
    const sum = (await store.protectionSummary({ days: 1 })).filter((r) => r.site_id === SITE_A);
    assert.equal(sum.find((r) => r.verdict === 'blocked').would_block, 1); assert.equal(sum.length, 3);
  });
  test('the queue captures REQUESTED baselines with the real browser and saves them; a project with no pages gets a recorded failure, and one failure does not stop the next', async (t) => {
    let launched = true; try { const b = await launch(); await b.close(); } catch { launched = false; }
    if (!launched) return t.skip('no browser');
    await db.query(`DELETE FROM design_baselines WHERE site_id = ANY($1)`, [[SITE_A, SITE_B]]);
    await store.requestBaseline(SITE_B, 'group:blog'); await store.requestBaseline(SITE_A, 'group:empty');
    const sites = {
      [SITE_B]: { id: SITE_B, url_file_map: { siteRoot: { designProfile: { layoutGroups: { groups: [{ id: 'blog', sample: '/blog/a', members: ['/blog/a', '/blog/b'] }] } } } } },
      [SITE_A]: { id: SITE_A, url_file_map: { siteRoot: { designProfile: { layoutGroups: { groups: [] } } } } },
    };
    const results = await capture.runProtectionBaselineQueue({ limit: 10, deps: { loadSite: async (id) => sites[id], originOf: () => base, capture: (a) => capture.captureTemplateBaseline({ ...a, launchBrowserFn: launch }) } });
    const byKey = Object.fromEntries(results.filter((r) => [SITE_A, SITE_B].includes(r.siteId)).map((r) => [r.templateKey, r]));
    assert.equal(byKey['group:blog'].status, 'ready'); assert.equal(byKey['group:blog'].samples, 2);
    assert.equal(byKey['group:empty'].status, 'failed'); assert.match(byKey['group:empty'].error, /no live pages/);
    const saved = await store.getBaseline(SITE_B, 'group:blog');
    assert.equal(saved.tokens.desktop.p.fontSize, 17); assert.equal(saved.tokens.mobile.p.fontSize, 17); assert.equal(store.baselineUsability(saved).usable, true);
    assert.equal(store.baselineUsability(await store.getBaseline(SITE_A, 'group:empty')).reason, 'capture-failed');
    assert.equal(await store.getBaseline(SITE_A, 'group:blog'), null, 'the other project got nothing from this capture');
  });
});
