import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSitemapRegistered, findSitemapUrl, sitemapFitsProperty } from './sitemap-register.js';

const site = { id: 1, gsc_property: 'sc-domain:example.com', website_domain: 'example.com' };
const XML = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>';
const files = (map) => async (url) => (url in map ? { ok: true, text: map[url] } : { ok: false });

describe('sitemapFitsProperty', () => {
  test('a domain property accepts the domain and its subdomains, nothing else', () => {
    assert.equal(sitemapFitsProperty('https://example.com/sitemap.xml', 'sc-domain:example.com'), true);
    assert.equal(sitemapFitsProperty('https://www.example.com/sitemap.xml', 'sc-domain:example.com'), true);
    assert.equal(sitemapFitsProperty('https://notexample.com/sitemap.xml', 'sc-domain:example.com'), false);
    assert.equal(sitemapFitsProperty('https://example.com.evil.io/sitemap.xml', 'sc-domain:example.com'), false);
  });
  test('a URL-prefix property only accepts sitemaps under its prefix', () => {
    assert.equal(sitemapFitsProperty('https://example.com/sitemap.xml', 'https://example.com/'), true);
    assert.equal(sitemapFitsProperty('https://example.com/blog/sitemap.xml', 'https://example.com/blog/'), true);
    assert.equal(sitemapFitsProperty('https://example.com/sitemap.xml', 'https://example.com/blog/'), false);
    assert.equal(sitemapFitsProperty('ftp://example.com/sitemap.xml', 'https://example.com/'), false);
  });
});

describe('findSitemapUrl', () => {
  test('prefers the sitemap robots.txt declares', async () => {
    const fetchText = files({
      'https://example.com/robots.txt': 'User-agent: *\nSitemap: https://example.com/custom-map.xml\n',
      'https://example.com/custom-map.xml': XML,
      'https://example.com/sitemap.xml': XML,
    });
    assert.deepEqual(await findSitemapUrl(site, { fetchText }), { found: true, url: 'https://example.com/custom-map.xml' });
  });
  test('falls back to /sitemap.xml, and never accepts a file that is not a sitemap', async () => {
    assert.equal((await findSitemapUrl(site, { fetchText: files({ 'https://example.com/sitemap.xml': XML }) })).url, 'https://example.com/sitemap.xml');
    const notXml = files({ 'https://example.com/sitemap.xml': '<html>not found</html>' });
    assert.deepEqual(await findSitemapUrl(site, { fetchText: notXml }), { found: false, reason: 'no-sitemap-found' });
  });
  test('ignores a robots.txt sitemap on another domain', async () => {
    const fetchText = files({ 'https://example.com/robots.txt': 'Sitemap: https://other.io/sitemap.xml\n', 'https://other.io/sitemap.xml': XML });
    assert.equal((await findSitemapUrl(site, { fetchText })).found, false);
  });
  test('no domain means no guess', async () => {
    assert.deepEqual(await findSitemapUrl({ gsc_property: null }, { fetchText: files({}) }), { found: false, reason: 'no-domain' });
  });
});

describe('ensureSitemapRegistered', () => {
  const fetchText = files({ 'https://example.com/sitemap.xml': XML });
  const none = async () => ({ ok: true, sitemaps: [] });

  test('submits the sitemap when the property has none', async () => {
    const calls = [];
    const r = await ensureSitemapRegistered(site, { list: none, fetchText, submit: async (s, u) => { calls.push(u); return { ok: true }; } });
    assert.deepEqual(r, { status: 'submitted', sitemap: 'https://example.com/sitemap.xml' });
    assert.deepEqual(calls, ['https://example.com/sitemap.xml']);
  });
  test('leaves an existing registration alone', async () => {
    const r = await ensureSitemapRegistered(site, {
      list: async () => ({ ok: true, sitemaps: [{ path: 'https://example.com/sitemap_index.xml' }] }), fetchText,
      submit: async () => { throw new Error('must not submit'); },
    });
    assert.equal(r.status, 'already-registered');
  });
  test('says so when Search Console only gave read access', async () => {
    const r = await ensureSitemapRegistered(site, { list: none, fetchText, submit: async () => ({ ok: false, reason: 'insufficient-scope', error: 'read only' }) });
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'insufficient-scope');
  });
  test('does nothing without a Search Console property, or when the list cannot be read', async () => {
    assert.equal((await ensureSitemapRegistered({ id: 1 }, { list: none, fetchText })).status, 'skipped');
    const r = await ensureSitemapRegistered(site, { list: async () => ({ ok: false, sitemaps: [], error: 'boom' }), fetchText, submit: async () => { throw new Error('must not submit'); } });
    assert.equal(r.status, 'failed');
  });
  test('no sitemap on the live site is a skip, not a guessed submit', async () => {
    const r = await ensureSitemapRegistered(site, { list: none, fetchText: files({}), submit: async () => { throw new Error('must not submit'); } });
    assert.deepEqual(r, { status: 'skipped', reason: 'no-sitemap-found' });
  });
});
