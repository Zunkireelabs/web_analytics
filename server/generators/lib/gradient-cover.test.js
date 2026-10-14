import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderBlogOutlineBody } from '../../implementers/lib/newpage-render.js';
import { gradientCoverSvg, coverConfigFor, buildGradientCover, seedOf, GRADIENT_ALT, PALETTES, palettesFor, ZUNKIREE_PALETTES } from './gradient-cover.js';

const SITE = { website_domain: 'zunkireelabs.com', url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', cover: { style: 'gradient', dir: 'src/assets/images/blog', urlBase: '/assets/images/blog/' } } } } };

describe('gradient-cover', () => {
  test('same seed → identical SVG; different seeds differ', () => {
    assert.equal(gradientCoverSvg('a-post'), gradientCoverSvg('a-post'));
    assert.notEqual(gradientCoverSvg('a-post'), gradientCoverSvg('another-post'));
  });

  test('is a standalone, text-free SVG with grain and an accessible label', () => {
    const svg = gradientCoverSvg('x');
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /feTurbulence/);
    assert.match(svg, new RegExp(`aria-label="${GRADIENT_ALT}"`));
    assert.doesNotMatch(svg, /<text|<script|href=|<image/);
  });

  test('palettes are all used across many seeds', () => {
    const used = new Set(Array.from({ length: 200 }, (_, i) => seedOf(`s${i}`) % PALETTES.length));
    assert.equal(used.size, PALETTES.length);
  });

  test('a site that has not opted in gets nothing (design is per tenant)', () => {
    assert.equal(coverConfigFor({ url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog' } } } }), null);
    assert.equal(coverConfigFor(null), null);
    assert.equal(buildGradientCover({}, { slug: 'x' }), null);
  });

  test('a malformed config is ignored, not guessed at', () => {
    const bad = (cover) => ({ url_file_map: { newContentTargets: { 'blog-outline': { cover } } } });
    assert.equal(coverConfigFor(bad({ style: 'photo', dir: 'a', urlBase: '/a' })), null);
    assert.equal(coverConfigFor(bad({ style: 'gradient', urlBase: '/a' })), null);
    assert.equal(coverConfigFor(bad({ style: 'gradient', dir: 'a', urlBase: 'a' })), null);
  });

  test('builds the file and the front-matter values; no photographer credit', () => {
    const c = buildGradientCover(SITE, { slug: 'what-is-ml' });
    assert.equal(c.file.path, 'src/assets/images/blog/what-is-ml.svg');
    assert.equal(c.file.contentFormat, 'asset');
    assert.equal(c.featuredImage.url, '/assets/images/blog/what-is-ml.svg');
    assert.equal(c.featuredImage.alt, GRADIENT_ALT);
    assert.equal(c.featuredImage.photographer, null);
  });

  test('an unsafe slug cannot escape the cover directory', () => {
    const c = buildGradientCover(SITE, { slug: '../../etc/passwd' });
    assert.ok(c.file.path.startsWith('src/assets/images/blog/'));
    assert.ok(!c.file.path.includes('..'));
  });

  test('rendered into a post, the cover is the front-matter image with no stock-photo credit', () => {
    const c = buildGradientCover(SITE, { slug: 'what-is-ml' });
    const body = renderBlogOutlineBody(
      { title: 'T', metaDescription: 'D', sections: [{ heading: 'H', body: 'B' }], featuredImage: c.featuredImage },
      SITE, { fieldNames: { featuredImage: 'featuredImage', featuredImageAlt: 'featuredImageAlt', featuredImageCredit: 'featuredImageCredit' } },
    );
    assert.match(body, /featuredImage: .*\/assets\/images\/blog\/what-is-ml\.svg/);
    assert.match(body, /featuredImageAlt: .*Abstract gradient background/);
    assert.doesNotMatch(body, /Pexels/);
  });
});

describe('gradient-cover — palettes belong to the tenant', () => {
  const coverCfg = { style: 'gradient', dir: 'a/b', urlBase: '/b/' };
  const siteWith = (extra, domain = 'acme.com') => ({ website_domain: domain, url_file_map: { newContentTargets: { 'blog-outline': { cover: { ...coverCfg, ...extra } } } } });
  const own = [{ top: '#111111', bottom: '#222222', left: '#333333', right: '#444444' }];

  test("another tenant that opts in is NEVER given Zunkireelabs's colours", () => {
    assert.equal(palettesFor(siteWith({})), null);
    assert.equal(buildGradientCover(siteWith({}), { slug: 'x' }), null, 'no palette means no cover, not a borrowed brand');
  });

  test("a tenant's own palettes are used", () => {
    const c = buildGradientCover(siteWith({ palettes: own }), { slug: 'x' });
    assert.ok(c.file.content.includes('#111111'));
    for (const z of ZUNKIREE_PALETTES) assert.ok(!c.file.content.includes(z.top));
  });

  test('malformed palette entries are dropped, and none left means no cover', () => {
    assert.equal(palettesFor(siteWith({ palettes: [{ top: 'red' }] })), null);
    assert.equal(palettesFor(siteWith({ palettes: [{ top: 'red' }, ...own] })).length, 1);
  });

  test("Zunkireelabs's own covers still reproduce byte for byte", () => {
    assert.equal(palettesFor({ website_domain: 'https://www.zunkireelabs.com' }), ZUNKIREE_PALETTES);
    assert.equal(gradientCoverSvg('a-post'), gradientCoverSvg('a-post', { palettes: ZUNKIREE_PALETTES }));
  });
});
