import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobotsDisallowRules, parseUrlsetXml } from './site-discovery.js';

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('./page-content.js'), {
  namedExports: {
    fetchTextIfExists: async () => ({ ok: false, text: '' }),
    isPrivateOrLocalHost: () => false,
    analyzePageUrl: async () => ({ ok: true, analysis: { internalLinks: [] } }),
  },
});

const { crawlSite } = await import('./site-discovery.js');

const ROBOTS_TXT = [
  'User-agent: *',
  'Disallow: /blog',
  'Allow: /blog/featured',
].join('\n');

describe('crawlSite — homepage URL', () => {
  // Regression, confirmed live on Chayce Properties (2026-09-18): `origin`
  // (new URL(...).origin) never carries a trailing slash by definition, but
  // every other discovered URL comes from a real `<a href="...">` on the
  // page, which this site writes WITH one. Seeding the crawl with the bare
  // origin recorded the homepage as its own separate page_inventory row
  // from "/", both for the exact same page.
  test('the homepage is discovered WITH a trailing slash, matching every other page\'s own URL convention', async () => {
    const site = { gsc_property: 'https://example.com' };
    const discovered = await crawlSite(site);
    assert.deepEqual(discovered, ['https://example.com/']);
  });
});

describe('parseRobotsDisallowRules — matchingDisallow', () => {
  test('returns the winning Disallow pattern for a blocked path', () => {
    const robots = parseRobotsDisallowRules(ROBOTS_TXT);
    assert.equal(robots.matchingDisallow('/blog/some-post'), '/blog');
  });

  test('returns null for a path an Allow rule wins on (longest-match)', () => {
    const robots = parseRobotsDisallowRules(ROBOTS_TXT);
    assert.equal(robots.matchingDisallow('/blog/featured'), null);
  });

  test('returns null for a path with no matching rule at all', () => {
    const robots = parseRobotsDisallowRules(ROBOTS_TXT);
    assert.equal(robots.matchingDisallow('/about'), null);
  });

  test('stays consistent with isAllowed on the same paths', () => {
    const robots = parseRobotsDisallowRules(ROBOTS_TXT);
    assert.equal(robots.isAllowed('/blog/some-post'), false);
    assert.equal(robots.matchingDisallow('/blog/some-post') !== null, true);
    assert.equal(robots.isAllowed('/blog/featured'), true);
    assert.equal(robots.matchingDisallow('/blog/featured'), null);
  });
});

describe('parseUrlsetXml', () => {
  test('parses <loc> plus <lastmod>/<changefreq>/<priority> for each entry', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url>
          <loc>https://example.com/a/</loc>
          <lastmod>2024-01-15</lastmod>
          <changefreq>weekly</changefreq>
          <priority>0.8</priority>
        </url>
      </urlset>`;
    const entries = parseUrlsetXml(xml);
    assert.deepEqual(entries, [{ loc: 'https://example.com/a/', lastmod: '2024-01-15', changefreq: 'weekly', priority: '0.8' }]);
  });

  test('missing optional fields resolve to null, not fabricated', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/bare/</loc></url>
    </urlset>`;
    const [entry] = parseUrlsetXml(xml);
    assert.equal(entry.loc, 'https://example.com/bare/');
    assert.equal(entry.lastmod, null);
    assert.equal(entry.changefreq, null);
    assert.equal(entry.priority, null);
  });

  test('parses multiple <url> entries', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/a/</loc></url>
      <url><loc>https://example.com/b/</loc></url>
    </urlset>`;
    const entries = parseUrlsetXml(xml);
    assert.deepEqual(entries.map((e) => e.loc), ['https://example.com/a/', 'https://example.com/b/']);
  });

  test('returns null (not entries) for a <sitemapindex> document — caller recurses instead', () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
    </sitemapindex>`;
    assert.equal(parseUrlsetXml(xml), null);
  });

  test('skips a <url> entry with no <loc>', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><lastmod>2024-01-01</lastmod></url>
      <url><loc>https://example.com/real/</loc></url>
    </urlset>`;
    const entries = parseUrlsetXml(xml);
    assert.deepEqual(entries.map((e) => e.loc), ['https://example.com/real/']);
  });
});
