import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sitemapGeneratorFromPackageJson, detectBuildGeneratedSitemap, generatedSitemapMessage } from './sitemap-generator-detect.js';

const pkg = (o) => JSON.stringify(o);

describe('sitemapGeneratorFromPackageJson', () => {
  test('admizz-web-dev: a prebuild script that runs generate-sitemap.mjs is a build-generated sitemap', () => {
    const r = sitemapGeneratorFromPackageJson(pkg({ scripts: { prebuild: 'node scripts/validate-events.mjs && node scripts/generate-sitemap.mjs && node scripts/generate-llms.mjs', dev: 'next dev' } }));
    assert.equal(r.generated, true);
    assert.match(r.reason, /prebuild/);
  });
  test('next-sitemap as a script or a dependency', () => {
    assert.equal(sitemapGeneratorFromPackageJson(pkg({ scripts: { postbuild: 'next-sitemap' } })).generated, true);
    assert.equal(sitemapGeneratorFromPackageJson(pkg({ devDependencies: { 'next-sitemap': '^4.0.0' } })).generated, true);
  });
  test('a site with no generator keeps the static-file behaviour', () => {
    assert.equal(sitemapGeneratorFromPackageJson(pkg({ scripts: { build: 'next build', lint: 'eslint .' }, dependencies: { next: '16' } })).generated, false);
  });
  test('unrelated mentions of "sitemap" do not count (e.g. a test or a ping)', () => {
    assert.equal(sitemapGeneratorFromPackageJson(pkg({ scripts: { test: 'node --test tests/sitemap-valid.test.js' } })).generated, false);
  });
  test('missing, empty or invalid package.json is "not detected", never an error', () => {
    for (const t of [null, undefined, '', 'not json', '[]', '123']) assert.equal(sitemapGeneratorFromPackageJson(t).generated, false);
  });
});

describe('detectBuildGeneratedSitemap', () => {
  test('reads package.json through the supplied fetcher, string or {content}', async () => {
    const text = pkg({ scripts: { prebuild: 'node scripts/generate-sitemap.mjs' } });
    assert.equal((await detectBuildGeneratedSitemap(async () => text)).generated, true);
    assert.equal((await detectBuildGeneratedSitemap(async (p) => (p === 'package.json' ? { content: text } : null))).generated, true);
  });
  test('a missing file or a failing fetch never blocks anything', async () => {
    assert.equal((await detectBuildGeneratedSitemap(async () => null)).generated, false);
    assert.equal((await detectBuildGeneratedSitemap(async () => { throw new Error('github down'); })).generated, false);
  });
  test('the message says why and what to change instead', () => {
    const m = generatedSitemapMessage('public/sitemap.xml', 'package.json script "prebuild" runs a sitemap generator');
    assert.match(m, /public\/sitemap\.xml/);
    assert.match(m, /overwritten at the next build/);
    assert.match(m, /noindex/);
  });
});
