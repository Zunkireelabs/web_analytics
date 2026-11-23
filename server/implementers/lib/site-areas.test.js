import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { areaOf, siteForUrl, siteForArea, isAreaView, areaNameOf, listAreas, AREA_VIEW, siteForDraft, siteForActionType, areaAwareImplementer, pageOfDraft } from './site-areas.js';
import { resolveFile, resolveNotApplicable } from './url-file-map.js';

const zennly = () => ({
  id: 8872, repo_owner: 'Zunkireelabs', repo_name: 'zennly-marketplace',
  url_file_map: {
    _rev: 3,
    siteRoot: { framework: 'mixed', layoutTemplate: 'shared.html' },
    pages: { '/ignored-shared': { file: 'never.txt' } },
    areas: [
      { name: 'business', include: ['/businesses'], override: {
        mounts: [{ prefix: '/businesses' }],
        pages: { '/faq': { file: 'marketing/src/faq.njk' }, '/': { file: 'marketing/src/index.njk' } },
        siteRoot: { layoutTemplate: 'marketing/src/_includes/base.njk' },
        notApplicable: [{ match: '/faq', actions: ['faq'], reason: 'FAQ is part of the template.' }],
      } },
      { name: 'marketplace', include: [], exclude: ['/businesses'], override: {
        pages: { '/': { file: 'src/app/page.tsx' }, '/search': { file: 'src/app/search/page.tsx' } },
        siteRoot: { layoutTemplate: 'src/app/layout.tsx' },
      } },
    ],
  },
});

describe('areaOf', () => {
  const site = zennly();
  test('/businesses and below belong to business; everything else to marketplace', () => {
    for (const u of ['https://zennly.io/businesses', 'https://zennly.io/businesses/', 'https://zennly.io/businesses/faq']) assert.equal(areaOf(site, u).name, 'business', u);
    for (const u of ['https://zennly.io/', 'https://zennly.io/search', 'https://zennly.io/providers/x']) assert.equal(areaOf(site, u).name, 'marketplace', u);
  });
  test('a prefix matches on a path-segment boundary: /businessesfoo is NOT business', () => {
    assert.equal(areaOf(site, 'https://zennly.io/businessesfoo').name, 'marketplace');
  });
  test('exclude always wins; the most specific include wins over a catch-all', () => {
    const s = zennly(); s.url_file_map.areas[1].include = ['/'];
    assert.equal(areaOf(s, 'https://zennly.io/businesses/x').name, 'business');
  });
  test('a site with no areas, or an unclaimed URL, gives null', () => {
    assert.equal(areaOf({ url_file_map: {} }, 'https://a.com/x'), null);
    assert.equal(areaOf(null, 'https://a.com/x'), null);
    const s = zennly(); s.url_file_map.areas = [s.url_file_map.areas[0]];
    assert.equal(areaOf(s, 'https://zennly.io/search'), null);
  });
  test('malformed area entries are ignored', () => {
    const s = zennly(); s.url_file_map.areas.push(null, { include: ['/x'] }, 'str');
    assert.equal(listAreas(s).length, 2);
  });
});

describe('siteForUrl returns the area as the whole site, so existing resolvers need no change', () => {
  const site = zennly();
  test('a business URL resolves through the business map, with its own mount', () => {
    const v = siteForUrl(site, 'https://zennly.io/businesses/faq');
    assert.equal(resolveFile(v, 'https://zennly.io/businesses/faq'), 'marketing/src/faq.njk');
    assert.equal(resolveFile(v, 'https://zennly.io/businesses'), 'marketing/src/index.njk');
    assert.equal(v.url_file_map.siteRoot.layoutTemplate, 'marketing/src/_includes/base.njk');
    assert.equal(v.url_file_map.siteRoot.framework, 'mixed', 'shared settings underneath are kept');
  });
  test('a marketplace URL resolves through the marketplace map, and "/" does not collide with the business home', () => {
    const v = siteForUrl(site, 'https://zennly.io/');
    assert.equal(resolveFile(v, 'https://zennly.io/'), 'src/app/page.tsx');
    assert.equal(v.url_file_map.siteRoot.layoutTemplate, 'src/app/layout.tsx');
  });
  test('an area never resolves another area\'s page, nor the shared pages table', () => {
    const biz = siteForUrl(site, 'https://zennly.io/businesses/faq');
    assert.equal(resolveFile(biz, 'https://zennly.io/search'), null);
    assert.equal(resolveFile(biz, 'https://zennly.io/ignored-shared'), null);
  });
  test('per-area declarations apply only in their area', () => {
    const biz = siteForUrl(site, 'https://zennly.io/businesses/faq');
    assert.ok(resolveNotApplicable(biz, 'https://zennly.io/businesses/faq', 'faq'));
    assert.equal(resolveNotApplicable(siteForUrl(site, 'https://zennly.io/search'), 'https://zennly.io/search', 'faq'), null);
  });
  test('a site without areas is returned untouched (same object)', () => {
    const plain = { id: 1, url_file_map: { pages: {} } };
    assert.equal(siteForUrl(plain, 'https://a.com/x'), plain);
  });
  test('the real site object and its map are never mutated', () => {
    const s = zennly(); const before = JSON.stringify(s);
    siteForUrl(s, 'https://zennly.io/businesses/faq'); siteForArea(s, 'marketplace');
    assert.equal(JSON.stringify(s), before);
  });
});

describe('the view is marked so it can never be saved back', () => {
  test('marker is present on views, absent on the real map, and invisible to JSON', () => {
    const s = zennly(); const v = siteForArea(s, 'business');
    assert.equal(isAreaView(v), true); assert.equal(areaNameOf(v), 'business');
    assert.equal(isAreaView(s), false);
    assert.ok(!JSON.stringify(v.url_file_map).includes('areaView'));
    assert.equal(v.url_file_map[AREA_VIEW].area, 'business');
  });
  test('the view does not carry the areas list (no recursion into another view)', () => {
    assert.equal('areas' in siteForArea(zennly(), 'business').url_file_map, false);
  });
  test('siteForArea with an unknown name returns the site unchanged', () => {
    const s = zennly(); assert.equal(siteForArea(s, 'nope'), s);
  });
});

describe('siteForDraft and areaAwareImplementer: every apply/preview/merge/rollback runs against the draft\'s own area', () => {
  const site = zennly();
  site.url_file_map.areas[0].override.newContentTargets = { 'blog-outline': { dir: 'marketing/src/blog', extension: '.md' } };
  site.url_file_map.areas[0].override.newContentNotApplicable = { 'cookie-policy': 'exists' };

  test('a page draft uses its page\'s area (content.page or input.page)', () => {
    assert.equal(areaNameOf(siteForDraft(site, { action_type: 'faq', content: { page: 'https://zennly.io/businesses/faq' } })), 'business');
    assert.equal(areaNameOf(siteForDraft(site, { action_type: 'faq', input: { page: 'https://zennly.io/search' } })), 'marketplace');
    assert.equal(pageOfDraft({}), null);
  });
  test('net-new content uses the area that declares a target or declaration for its type', () => {
    assert.equal(areaNameOf(siteForDraft(site, { action_type: 'blog-outline', content: {} })), 'business');
    assert.equal(areaNameOf(siteForActionType(site, 'cookie-policy')), 'business');
    assert.equal(siteForActionType(site, 'direct-answer'), site, 'no area owns it: the site as it is');
  });
  test('the wrapper hands each method the draft\'s area view and keeps everything else', async () => {
    const seen = [];
    const impl = {
      meta: { id: 'x' }, helper: () => 'h',
      apply: async (s, d, o) => { seen.push(['apply', areaNameOf(s), o]); return 'a'; },
      preview: async (s) => { seen.push(['preview', areaNameOf(s)]); return 'p'; },
      mergeToStage: async (s) => { seen.push(['merge', areaNameOf(s)]); return 'm'; },
      rollback: async (s) => { seen.push(['rollback', areaNameOf(s)]); return 'r'; },
    };
    const w = areaAwareImplementer(impl);
    const draft = { action_type: 'faq', content: { page: 'https://zennly.io/businesses/faq' } };
    assert.deepEqual([await w.apply(site, draft, { renderModeOverride: 'visible' }), await w.preview(site, draft), await w.mergeToStage(site, draft), await w.rollback(site, draft)], ['a', 'p', 'm', 'r']);
    assert.deepEqual(seen, [['apply', 'business', { renderModeOverride: 'visible' }], ['preview', 'business'], ['merge', 'business'], ['rollback', 'business']]);
    assert.equal(w.meta.id, 'x'); assert.equal(w.helper(), 'h');
  });
  test('for a site without areas the implementer receives the very same site object', async () => {
    const plain = { id: 1, url_file_map: {} }; let got;
    await areaAwareImplementer({ apply: async (s) => { got = s; } }).apply(plain, { action_type: 'faq', content: { page: 'https://a.com/x' } });
    assert.equal(got, plain);
  });
  test('a null implementer stays null', () => assert.equal(areaAwareImplementer(null), null));
});
