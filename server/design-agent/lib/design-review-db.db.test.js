// The dedicated-table design review backend against a REAL Postgres (migration 249).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../../db.js';
import { createTableReviewStore } from './design-review-db.js';
import { createReviewStore, __resetBackendDetection } from './design-review-store.js';
import { runDesignValidationStage } from './design-validation-stage.js';
import { createFetchCache, computeLayoutFingerprint } from './live-design-validation.js';

const O = 'https://x.test';
let siteId; let store;
const groups = () => ({ revision: 3, groups: [
  { id: 'g1', size: 3, sample: '/blog/a', members: ['/blog/a', '/blog/b', '/blog/c'] },
  { id: 'g2', size: 1, sample: '/services/x', members: ['/services/x'] },
] });
const profile = () => ({ pages: [{ url: `${O}/blog/a`, sections: [{ role: 'content', classes: 'post' }] }], layoutGroups: groups() });
const map = async () => (await query('SELECT url_file_map FROM sites WHERE id = $1', [siteId])).rows[0].url_file_map;

before(async () => {
  siteId = (await query('INSERT INTO sites (name, url_file_map) VALUES ($1,$2) RETURNING id', ['review-db', JSON.stringify({ pages: {}, siteRoot: { designProfile: profile(), other: { keep: 1 } } })])).rows[0].id;
  store = createTableReviewStore({ pool });
});
after(async () => { await query('DELETE FROM sites WHERE id = $1', [siteId]); await pool.end(); });

describe('table backend', () => {
  test('auto-selection: createReviewStore uses the tables when they exist', async () => {
    __resetBackendDetection();
    const auto = createReviewStore({ pool });
    assert.equal((await auto.resolve()).backend, 'tables');
  });

  test('recordValidation: evidence row + remembered result + ONE pending proposal; repeats are de-duplicated; url_file_map untouched', async () => {
    const before = JSON.stringify((await map()).siteRoot);
    const rec = { pagePath: '/blog/c', evidence: { kind: 'validation', status: 'provisional' }, result: { outcome: 'provisional', fingerprintHash: 'h1' }, proposal: { kind: 'new-group', pageUrl: `${O}/blog/c`, capture: { fingerprint: { hash: 'h1' } }, entry: { url: `${O}/blog/c`, sections: [{ role: 'content', classes: 'new' }] } } };
    const a = await store.recordValidation(siteId, rec);
    const b = await store.recordValidation(siteId, rec);
    assert.equal(b.proposalId, a.proposalId); assert.equal(b.deduplicated, true);
    assert.equal((await store.listPending(siteId)).length, 1);
    assert.equal((await store.listEvidence(siteId)).length, 2);
    assert.equal(JSON.stringify((await map()).siteRoot), before, 'no whole-config rewrite per validation');
  });

  test('approve: group map, proposal status and history are written in ONE transaction; other config preserved', async () => {
    const [p] = await store.listPending(siteId);
    await store.approve(siteId, p.id, { by: 'Reviewer', expectedRevision: 3 });
    const m = await map();
    assert.equal(m.siteRoot.designProfile.layoutGroups.revision, 4);
    assert.ok(m.siteRoot.designProfile.layoutGroups.groups.some((g) => g.sample === '/blog/c'));
    assert.deepEqual(m.siteRoot.other, { keep: 1 });
    assert.equal((await store.getProposal(siteId, p.id)).status, 'approved');
    const [h] = await store.listHistory(siteId);
    assert.deepEqual([h.action, h.by, h.revision], ['approve', 'Reviewer', 4]);
  });

  test('a stale approval (reviewed at an older revision) is refused and changes nothing', async () => {
    const id = await store.addProposal(siteId, { kind: 'join', pagePath: '/blog/b', groupId: 'g2', payload: { pageUrl: `${O}/blog/b` } });
    const snap = JSON.stringify(await map());
    await assert.rejects(store.approve(siteId, id, { by: 'R', expectedRevision: 3 }), (e) => e.code === 'revision-conflict');
    assert.equal(JSON.stringify(await map()), snap);
    assert.equal((await store.getProposal(siteId, id)).status, 'pending');
  });

  test('two concurrent approvals at the same revision: exactly one lands', async () => {
    const x = await store.addProposal(siteId, { kind: 'join', pagePath: '/blog/b', groupId: 'g2', payload: { pageUrl: `${O}/blog/b` } });
    const y = await store.addProposal(siteId, { kind: 'join', pagePath: '/services/x2', groupId: 'g1', payload: { pageUrl: `${O}/services/x2` } });
    const rs = await Promise.allSettled([store.approve(siteId, x, { by: 'A', expectedRevision: 4 }), store.approve(siteId, y, { by: 'B', expectedRevision: 4 })]);
    assert.deepEqual(rs.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await map()).siteRoot.designProfile.layoutGroups.revision, 5);
  });

  test('rollback restores the previous group map exactly and is itself recorded', async () => {
    const beforeLast = (await store.listHistory(siteId, 1))[0].before.groups;
    await store.rollbackLast(siteId, { by: 'R', expectedRevision: 5 });
    const m = await map();
    assert.deepEqual(m.siteRoot.designProfile.layoutGroups.groups, beforeLast);
    assert.equal(m.siteRoot.designProfile.layoutGroups.revision, 6);
    assert.equal((await store.listHistory(siteId, 1))[0].action, 'rollback');
  });

  test('the real validation stage reads its memo from the tables (no re-validation of an unchanged page)', async () => {
    const html = '<html><body><main><section class="post wrap a b"><p>x</p></section></main></body></html>';
    const fp = computeLayoutFingerprint(html);
    await query(`INSERT INTO design_page_results (site_id, page_path, result) VALUES ($1,'/blog/a',$2) ON CONFLICT (site_id,page_path) DO UPDATE SET result = EXCLUDED.result`, [siteId, JSON.stringify({ outcome: 'matched', fingerprintHash: fp.hash, groupId: 'g1', expiresAt: '2999-01-01T00:00:00Z' })]);
    const site = { id: siteId, url_file_map: (await map()) };
    const r = await runDesignValidationStage({ site, generatorId: 'faq', pageUrl: `${O}/blog/a`, store, pageCache: createFetchCache(), fetchHtml: async () => html, validate: async () => assert.fail('must reuse the remembered result') });
    assert.equal(r.memo, 'hit');
    assert.ok((await store.listEvidence(siteId)).some((e) => e.payload.memo === 'hit'));
  });

  test('cross-worker de-duplication: two concurrent validations of the SAME page validate (and capture) once; the second reuses the first\'s result', async () => {
    const html = '<html><body><main><section class="post wrap a b c"><p>x</p></section></main></body></html>';
    await query('DELETE FROM design_page_results WHERE site_id = $1 AND page_path = $2', [siteId, '/blog/a']);
    const site = { id: siteId, url_file_map: (await map()) };
    let validations = 0;
    const fp = computeLayoutFingerprint(html);
    const validate = async () => {
      validations++;
      await new Promise((r) => setTimeout(r, 300)); // a slow validation: the other worker must wait, not duplicate it
      return { status: 'matched', reason: 'ok', fingerprint: fp, context: { pagePath: '/blog/a', groupId: 'g1', fingerprint: fp }, proposal: null };
    };
    // two "workers": separate fetch caches, the real advisory page lock, the shared table store
    const run = () => runDesignValidationStage({ site, generatorId: 'faq', pageUrl: `${O}/blog/a`, store, pageCache: createFetchCache(), fetchHtml: async () => html, validate });
    const [r1, r2] = await Promise.all([run(), run()]);
    assert.equal(validations, 1, 'validated once across both workers');
    assert.deepEqual([r1.memo, r2.memo].sort(), ['hit', 'miss']);
  });

  test('REGRESSION: approving a BATCH join invalidates the remembered results of every page it moved', async () => {
    await query(`INSERT INTO design_page_results (site_id, page_path, result) VALUES ($1,'/blog/en-1',$2),($1,'/blog/en-2',$2)
                 ON CONFLICT (site_id,page_path) DO UPDATE SET result = EXCLUDED.result`, [siteId, JSON.stringify({ outcome: 'matched-other-group', fingerprintHash: 'h', groupId: 'g1', expiresAt: '2999-01-01T00:00:00Z' })]);
    const id = await store.addProposal(siteId, { kind: 'join', groupId: 'g2', pagePath: 'join:g2', payload: { members: ['/blog/en-1', '/blog/en-2'] } });
    await store.approve(siteId, id, { by: 'R', expectedRevision: (await map()).siteRoot.designProfile.layoutGroups.revision });
    const left = (await query('SELECT count(*)::int AS n FROM design_page_results WHERE site_id = $1', [siteId])).rows[0].n;
    assert.equal(left, 0, 'no page may keep an answer that described the old map');
  });

  test('REGRESSION (race): the page lock is held until the result is SAVED — a slow save still validates once', async () => {
    const html = '<html><body><main><section class="post wrap a b c"><p>x</p></section></main></body></html>';
    await query('DELETE FROM design_page_results WHERE site_id = $1 AND page_path = $2', [siteId, '/blog/a']);
    const site = { id: siteId, url_file_map: (await map()) };
    const fp = computeLayoutFingerprint(html);
    let validations = 0;
    // widen the gap between "validated" and "saved" — the window the old code released the lock in
    const slowStore = { ...store, recordValidation: async (...a) => { await new Promise((r) => setTimeout(r, 400)); return store.recordValidation(...a); } };
    const run = () => runDesignValidationStage({ site, generatorId: 'faq', pageUrl: `${O}/blog/a`, store: slowStore, pageCache: createFetchCache(), fetchHtml: async () => html,
      validate: async () => { validations++; return { status: 'matched', reason: 'ok', fingerprint: fp, context: { pagePath: '/blog/a', groupId: 'g1', fingerprint: fp }, proposal: null }; } });
    await Promise.all([run(), run()]);
    assert.equal(validations, 1);
  });
});
