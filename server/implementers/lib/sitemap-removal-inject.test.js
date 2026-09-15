import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { removeUrlsFromSitemap } from './sitemap-removal-inject.js';

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <lastmod>2026-09-03</lastmod>
  </url>
  <url>
    <loc>https://example.com/blocked-page/</loc>
    <lastmod>2026-09-03</lastmod>
  </url>
  <url>
    <loc>https://example.com/about/</loc>
    <lastmod>2026-09-03</lastmod>
  </url>
</urlset>
`;

describe('removeUrlsFromSitemap', () => {
  test('removes exactly the requested URL, preserving everything else', () => {
    const result = removeUrlsFromSitemap(FIXTURE, ['https://example.com/blocked-page/']);
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.newContent, /blocked-page/);
    assert.match(result.newContent, /https:\/\/example\.com\/<\/loc>/);
    assert.match(result.newContent, /https:\/\/example\.com\/about\/<\/loc>/);
    assert.equal(result.removedCount, 1);
  });

  test('removes multiple requested URLs in one pass', () => {
    const result = removeUrlsFromSitemap(FIXTURE, ['https://example.com/blocked-page/', 'https://example.com/about/']);
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.newContent, /blocked-page/);
    assert.doesNotMatch(result.newContent, /\/about\//);
    assert.match(result.newContent, /https:\/\/example\.com\/<\/loc>/);
    assert.equal(result.removedCount, 2);
  });

  test('refuses the WHOLE operation, all-or-nothing, when one requested URL is not found', () => {
    const result = removeUrlsFromSitemap(FIXTURE, ['https://example.com/blocked-page/', 'https://example.com/does-not-exist/']);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
    assert.match(result.error, /does-not-exist/);
  });

  test('refuses cleanly when nothing requested is present at all', () => {
    const result = removeUrlsFromSitemap(FIXTURE, ['https://example.com/never-existed/']);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
  });

  test('the resulting XML still has a valid urlset root and no dangling tags', () => {
    const result = removeUrlsFromSitemap(FIXTURE, ['https://example.com/blocked-page/']);
    assert.match(result.newContent, /<urlset/);
    assert.match(result.newContent, /<\/urlset>/);
    const openCount = (result.newContent.match(/<url>/g) || []).length;
    const closeCount = (result.newContent.match(/<\/url>/g) || []).length;
    assert.equal(openCount, closeCount);
    assert.equal(openCount, 2);
  });
});
