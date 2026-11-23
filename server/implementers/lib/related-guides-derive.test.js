import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ensureRelatedGuidesTemplates, mutateMap, deriveRelatedGuidesTemplate, candidatePages } from './related-guides-derive.js';

const POST = `<main><article>x</article><section><h2>Related Articles</h2><div>${[1, 2, 3].map((n) => `<a class="card" href="/p${n}"><img src="/i${n}.jpg"><h3>T${n}</h3><p>D${n}</p></a>`).join('')}</div></section></main>`;
const PLAIN = '<main><h1>Hi</h1><p>text</p></main>';
const site = (over = {}) => ({ id: 7, repo_owner: 'o', repo_name: 'r', website_domain: 'client.test', url_file_map: { siteRoot: {} }, ...over });
const sitemap = (urls) => `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const getWith = (pageHtml) => async (u) => (u.endsWith('/sitemap.xml') ? sitemap(['https://client.test/blog/a', 'https://client.test/about']) : pageHtml);
// a fake of the row-locked map write: applies the mutator to a stored map the way patchUrlFileMap does
const fakeStore = (initial) => { const st = { map: initial, writes: 0 }; st.patch = async (_id, mutator) => { const next = await mutator(JSON.parse(JSON.stringify(st.map))); if (next == null) return { changed: false }; st.map = next; st.writes++; return { changed: true }; }; return st; };
const measure = async () => ({ bodyColor: 'rgb(0, 0, 0)', bodyBg: 'rgb(255, 255, 255)', radius: 12 });

describe('ensureRelatedGuidesTemplates (the daily step)', () => {
  test('a site that shows its related guides as cards: the card is copied and saved', async () => {
    const st = fakeStore({ siteRoot: { layoutTemplate: 'l' } });
    const r = await ensureRelatedGuidesTemplates(site({ url_file_map: st.map }), { patch: st.patch, get: getWith(POST), measure });
    assert.deepEqual(r, [{ area: null, outcome: 'saved-card' }]);
    assert.match(st.map.siteRoot.componentTemplates.relatedGuidesCard.card, /class="card"/);
    assert.equal(st.map.siteRoot.layoutTemplate, 'l', 'nothing else in the map changes');
  });
  test('a site with no card: its measured look is saved for the standard card', async () => {
    const st = fakeStore({ siteRoot: {} });
    const r = await ensureRelatedGuidesTemplates(site({ url_file_map: st.map }), { patch: st.patch, get: getWith(PLAIN), measure });
    assert.deepEqual(r, [{ area: null, outcome: 'saved-standard' }]);
    assert.equal(st.map.siteRoot.componentTemplates.relatedGuidesStandard.radius, 12);
  });
  test('a site that already has one saved is never overwritten, and nothing is fetched or written', async () => {
    const st = fakeStore({ siteRoot: { componentTemplates: { relatedGuidesCard: { card: 'mine', section: 's' } } } });
    let fetched = 0;
    const r = await ensureRelatedGuidesTemplates(site({ url_file_map: st.map }), { patch: st.patch, get: async () => { fetched++; return POST; }, measure });
    assert.deepEqual(r, [{ area: null, outcome: 'present' }]); assert.equal(fetched, 0); assert.equal(st.writes, 0);
    assert.equal(st.map.siteRoot.componentTemplates.relatedGuidesCard.card, 'mine');
  });
  test('if someone saves one between our read and our write, the write changes nothing', async () => {
    const st = fakeStore({ siteRoot: {} });
    const racing = async (id, mutator) => { st.map = { siteRoot: { componentTemplates: { relatedGuidesStandard: { radius: 1 } } } }; return st.patch(id, mutator); };
    const r = await ensureRelatedGuidesTemplates(site({ url_file_map: { siteRoot: {} } }), { patch: racing, get: getWith(POST), measure });
    assert.deepEqual(r, [{ area: null, outcome: 'present' }]); assert.deepEqual(st.map.siteRoot.componentTemplates.relatedGuidesStandard, { radius: 1 });
  });
  test('a held-back site (sectionOrder off) is skipped entirely: MOBILISE stays untouched', async () => {
    const st = fakeStore({ siteRoot: { sectionOrder: 'off' } }); let fetched = 0;
    const r = await ensureRelatedGuidesTemplates(site({ url_file_map: st.map }), { patch: st.patch, get: async () => { fetched++; return POST; }, measure });
    assert.deepEqual(r, [{ area: null, outcome: 'held' }]); assert.equal(fetched, 0); assert.equal(st.writes, 0);
  });
  test('no repo, no domain, or the kill switch: skipped, nothing fetched', async () => {
    const deps = { patch: async () => assert.fail('must not write'), get: async () => assert.fail('must not fetch'), measure };
    assert.equal((await ensureRelatedGuidesTemplates(site({ repo_owner: null }), deps))[0].outcome, 'skipped:no-repo');
    assert.equal((await ensureRelatedGuidesTemplates(site({ website_domain: null }), deps))[0].outcome, 'skipped:no-domain');
    assert.equal((await ensureRelatedGuidesTemplates(site(), { ...deps, env: { RELATED_GUIDES_AUTODERIVE: 'off' } }))[0].outcome, 'skipped:switched-off');
  });
  test('nothing readable (no sitemap pages, or no browser to measure) saves nothing and does not fail', async () => {
    const st = fakeStore({ siteRoot: {} });
    assert.equal((await ensureRelatedGuidesTemplates(site({ url_file_map: st.map }), { patch: st.patch, get: async () => '', measure }))[0].outcome, 'none-found');
    assert.equal((await ensureRelatedGuidesTemplates(site({ url_file_map: st.map }), { patch: st.patch, get: getWith(PLAIN), measure: async () => null }))[0].outcome, 'none-found');
    assert.equal(st.writes, 0);
  });
  test('a failing write is reported, never thrown', async () => {
    const r = await ensureRelatedGuidesTemplates(site(), { patch: async () => { throw new Error('db down'); }, get: getWith(POST), measure });
    assert.match(r[0].outcome, /^error:db down/);
  });
  test('a site with areas is handled area by area, each saved in its own area, and a held area is skipped', async () => {
    const map = { areas: [{ name: 'business', include: ['/businesses'], override: { siteRoot: {} } }, { name: 'marketplace', include: [], exclude: ['/businesses'], override: { siteRoot: { sectionOrder: 'off' } } }], siteRoot: {} };
    const st = fakeStore(map);
    const get = async (u) => (u.endsWith('/sitemap.xml') ? sitemap(['https://client.test/businesses/blog/a', 'https://client.test/search']) : u.includes('/businesses/') ? POST : PLAIN);
    const r = await ensureRelatedGuidesTemplates(site({ url_file_map: map }), { patch: st.patch, get, measure });
    assert.deepEqual(r, [{ area: 'business', outcome: 'saved-card' }, { area: 'marketplace', outcome: 'held' }]);
    assert.ok(st.map.areas[0].override.siteRoot.componentTemplates.relatedGuidesCard);
    assert.equal(st.map.areas[1].override.siteRoot.componentTemplates, undefined); assert.deepEqual(st.map.siteRoot, {});
  });
  test('an area only reads pages that belong to it', async () => {
    const map = { areas: [{ name: 'business', include: ['/businesses'], override: {} }, { name: 'marketplace', include: [], exclude: ['/businesses'], override: {} }] };
    const seen = [];
    await deriveRelatedGuidesTemplate(site({ url_file_map: map }), { urlFilter: (u) => !u.includes('/businesses'), get: async (u) => { seen.push(u); return u.endsWith('/sitemap.xml') ? sitemap(['https://client.test/businesses/a', 'https://client.test/search']) : PLAIN; }, measure });
    assert.ok(seen.some((u) => u.endsWith('/search'))); assert.ok(!seen.some((u) => u.includes('/businesses/')));
  });
});

describe('library pieces', () => {
  test('mutateMap onlyIfMissing returns null (no write) when one is already saved', () => {
    assert.equal(mutateMap({ siteRoot: { componentTemplates: { relatedGuidesCard: {} } } }, { relatedGuidesStandard: { radius: 1 }, onlyIfMissing: true }), null);
  });
  test('candidatePages follows a sitemap index and ignores xml and other origins', async () => {
    const get = async (u) => (u.endsWith('/sitemap.xml') ? '' : u.endsWith('/sitemap-index.xml') ? '<sitemapindex><sitemap><loc>https://client.test/sitemap-0.xml</loc></sitemap></sitemapindex>' : u.endsWith('/sitemap-0.xml') ? sitemap(['https://client.test/blog/x', 'https://other.test/y']) : '');
    assert.deepEqual(await candidatePages(site(), { get }), ['https://client.test/blog/x']);
  });
});
