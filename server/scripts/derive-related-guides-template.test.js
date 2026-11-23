import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mutateMap, samplePages } from './derive-related-guides-template.js';

const card = { card: '<a href="{{URL}}">{{TITLE}}</a>', section: '<section>{{CARDS}}</section>' };
describe('mutateMap saves the card or the measured look in the right place and touches nothing else', () => {
  test('a plain site: the card goes into siteRoot.componentTemplates, replacing an older one', () => {
    const base = { _rev: 4, pages: { '/': { file: 'a' } }, siteRoot: { layoutTemplate: 'l', componentTemplates: { faq: { row: 'r' }, relatedGuidesStandard: { radius: 1 } } } };
    const out = mutateMap(base, { relatedGuidesCard: card });
    assert.deepEqual(out.siteRoot.componentTemplates.relatedGuidesCard, card);
    assert.equal('relatedGuidesStandard' in out.siteRoot.componentTemplates, false, 'a site has one or the other, not both');
    assert.deepEqual(out.siteRoot.componentTemplates.faq, { row: 'r' }); assert.equal(out._rev, 4); assert.deepEqual(out.pages, base.pages);
    assert.equal(base.siteRoot.componentTemplates.relatedGuidesStandard.radius, 1, 'the input is not mutated');
  });
  test('measured tokens are saved as relatedGuidesStandard', () => {
    const out = mutateMap({ siteRoot: {} }, { relatedGuidesStandard: { radius: 16 } });
    assert.deepEqual(out.siteRoot.componentTemplates.relatedGuidesStandard, { radius: 16 });
  });
  test('a site with areas needs --area, and writes only into that area', () => {
    const base = { areas: [{ name: 'business', override: {} }, { name: 'marketplace', override: { siteRoot: { x: 1 } } }], siteRoot: {} };
    assert.throws(() => mutateMap(base, { relatedGuidesCard: card }), /pass --area/);
    assert.throws(() => mutateMap(base, { area: 'nope', relatedGuidesCard: card }), /No area "nope"/);
    const out = mutateMap(base, { area: 'marketplace', relatedGuidesStandard: { radius: 8 } });
    assert.deepEqual(out.areas[1].override.siteRoot.componentTemplates.relatedGuidesStandard, { radius: 8 });
    assert.equal(out.areas[1].override.siteRoot.x, 1); assert.deepEqual(out.areas[0].override, {}); assert.deepEqual(out.siteRoot, {});
  });
});

describe('samplePages finds a site\'s posts even when they are not under /blog/', () => {
  const origin = 'https://admizz.test';
  const locs = [...Array.from({ length: 60 }, (_, i) => `${origin}/page-${i}`), `${origin}/blog/real-post`, `${origin}/sitemap-2.xml`, 'https://other.test/x'];
  test('blog-like pages first, then an even spread, within the limit, on the site\'s own origin, never a sitemap or an image', () => {
    const out = samplePages(locs, origin, 30);
    assert.equal(out[0], `${origin}/blog/real-post`); assert.ok(out.length <= 30 && out.length > 10);
    assert.ok(out.every((u) => u.startsWith(origin) && !/\.xml/.test(u)));
    assert.ok(out.some((u) => /page-5\d/.test(u)), 'the sample reaches late pages, not just the first few');
  });
});
