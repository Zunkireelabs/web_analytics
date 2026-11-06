// Migration 249 against a REAL Postgres: lost updates on sites.url_file_map are impossible.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, updateSiteRepoConfig, patchUrlFileMap, UrlFileMapConflictError } from '../db.js';

let siteA; let siteB;
const readMap = async (id) => (await query('SELECT url_file_map FROM sites WHERE id = $1', [id])).rows[0].url_file_map;
const newSite = async (name) => (await query(`INSERT INTO sites (name, url_file_map) VALUES ($1, $2) RETURNING id`, [name, JSON.stringify({ pages: { '/': 'index.njk' }, siteRoot: { designProfile: { v: 1 }, componentTemplates: { faq: 'old' } } })])).rows[0].id;

before(async () => { siteA = await newSite('concurrency-a'); siteB = await newSite('concurrency-b'); });
after(async () => { await query('DELETE FROM sites WHERE id = ANY($1)', [[siteA, siteB]]); await pool.end(); });

describe('url_file_map lost-update protection (migration 249)', () => {
  test('new rows start at revision 0 and every write advances it', async () => {
    assert.equal((await readMap(siteA))._rev, 0);
    const snap = await readMap(siteA);
    await updateSiteRepoConfig({ siteId: siteA, urlFileMap: { ...snap, pages: { ...snap.pages, '/x': 'x.njk' } } });
    assert.equal((await readMap(siteA))._rev, 1);
  });

  test('ROOT CAUSE: two writers from the same snapshot changing different parts — BOTH changes survive', async () => {
    const snap = await readMap(siteA);
    const [w1, w2] = await Promise.all([
      updateSiteRepoConfig({ siteId: siteA, urlFileMap: { ...snap, siteRoot: { ...snap.siteRoot, designProfile: { v: 2 } } } }),
      updateSiteRepoConfig({ siteId: siteA, urlFileMap: { ...snap, siteRoot: { ...snap.siteRoot, componentTemplates: { faq: 'new' } } } }),
    ]);
    assert.ok(w1 && w2);
    const m = await readMap(siteA);
    assert.deepEqual(m.siteRoot.designProfile, { v: 2 });
    assert.equal(m.siteRoot.componentTemplates.faq, 'new');
  });

  test('two writers changing the SAME value differently: the second is refused loudly; the first stays', async () => {
    const snap = await readMap(siteA);
    await updateSiteRepoConfig({ siteId: siteA, urlFileMap: { ...snap, siteRoot: { ...snap.siteRoot, designProfile: { v: 'first' } } } });
    await assert.rejects(
      updateSiteRepoConfig({ siteId: siteA, urlFileMap: { ...snap, siteRoot: { ...snap.siteRoot, designProfile: { v: 'second' } } } }),
      (e) => e instanceof UrlFileMapConflictError && e.conflicts.includes('siteRoot.designProfile.v'),
    );
    assert.equal((await readMap(siteA)).siteRoot.designProfile.v, 'first');
  });

  test('a legacy raw-SQL writer (operator script) with a stale snapshot is refused by the database itself', async () => {
    const snap = await readMap(siteA);
    await patchUrlFileMap(siteA, (m) => ({ ...m, marker: 'fresh' }));
    await assert.rejects(query('UPDATE sites SET url_file_map = $1 WHERE id = $2', [JSON.stringify({ ...snap, pages: {} }), siteA]), /stale url_file_map write/);
    const m = await readMap(siteA);
    assert.equal(m.marker, 'fresh'); assert.ok(Object.keys(m.pages).length > 0, 'nothing was erased');
  });

  test('patchUrlFileMap: 15 concurrent read-modify-writes all land', async () => {
    await Promise.all(Array.from({ length: 15 }, (_, i) => patchUrlFileMap(siteB, (m) => ({ ...m, counters: { ...(m.counters || {}), [`k${i}`]: i } }))));
    assert.equal(Object.keys((await readMap(siteB)).counters).length, 15);
  });

  test('previous versions are retained (bounded) so a bad write can be rolled back', async () => {
    const { rows } = await query('SELECT rev FROM url_file_map_versions WHERE site_id = $1 ORDER BY rev', [siteB]);
    assert.ok(rows.length >= 10 && rows.length <= 21, `${rows.length} versions`);
  });

  test('after a refused write, unrelated work continues: the same site accepts a fresh write and another site is untouched', async () => {
    const fresh = await readMap(siteA);
    await updateSiteRepoConfig({ siteId: siteA, urlFileMap: { ...fresh, after: 'ok' } });
    assert.equal((await readMap(siteA)).after, 'ok');
    assert.equal((await readMap(siteB)).counters.k0, 0);
  });
});
