import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readTar, scanTarballForTracking, scanRepoForTracking } from './repo-tracking-scan.js';

// Build a real ustar archive in memory (GitHub's tarball shape: every path under one "<owner>-<repo>-<sha>/" folder).
function tar(files) {
  const blocks = [];
  for (const [path, text] of Object.entries(files)) {
    const data = Buffer.from(text); const h = Buffer.alloc(512);
    h.write(`owner-repo-abc123/${path}`.slice(0, 100), 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156);
    let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe('scanTarballForTracking', () => {
  test('finds a consent-gated GA4 loader in a bundled script (the SuperRank shape)', () => {
    const gz = tar({ 'src/scripts/cookie-consent.js': "export const GA_ID = 'G-7V8PXXZF3G';\nwin.gtag('config', GA_ID); s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;" });
    const hits = scanTarballForTracking(gz);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, 'src/scripts/cookie-consent.js');
    assert.deepEqual(hits[0].ga4, ['G-7V8PXXZF3G']);
    assert.equal(hits[0].gtag, true);
  });
  test('finds a layout tag and a GTM container', () => {
    const gz = tar({ 'src/_includes/base.njk': '<script async src="https://www.googletagmanager.com/gtag/js?id=G-6LYQRZY03B"></script><script>gtag(\'config\', \'G-6LYQRZY03B\');</script>', 'src/other.html': "<script src='https://www.googletagmanager.com/gtm.js?id=GTM-ABCD123'></script>" });
    const hits = scanTarballForTracking(gz);
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.find((h) => h.path.endsWith('base.njk')).ga4, ['G-6LYQRZY03B']);
    assert.deepEqual(hits.find((h) => h.path.endsWith('other.html')).gtm, ['GTM-ABCD123']);
  });
  test('a repo with no tracking, test fixtures, node_modules and unrelated G- text report nothing', () => {
    const gz = tar({ 'src/page.astro': '<h1>Hello</h1> G-FORCE and G-SHOCK watches', 'node_modules/x/a.js': "gtag('config','G-AAAAAAAA')", 'src/a.test.js': "gtag('config','G-BBBBBBBB')" });
    assert.deepEqual(scanTarballForTracking(gz), []);
  });
  test('readTar returns paths without the GitHub prefix folder', () => {
    assert.deepEqual([...readTar(gunzipSync(tar({ 'a/b.txt': 'x' })))].map((f) => f.path), ['a/b.txt']);
  });
});

describe('scanRepoForTracking', () => {
  const site = { id: 1 };
  test('scans each distinct ref once and returns its hits', async () => {
    const asked = [];
    const r = await scanRepoForTracking(site, ['main', 'stage', 'main', null], { fetchTarball: async (_s, ref) => { asked.push(ref); return tar({ 'x.html': "gtag('config','G-AAAA1111')" }); } });
    assert.deepEqual(asked, ['main', 'stage']);
    assert.equal(r.ok, true);
    assert.equal(r.refs.length, 2);
  });
  test('an unreadable repo is reported, never treated as "no tracking"', async () => {
    const r = await scanRepoForTracking(site, ['main'], { fetchTarball: async () => { throw new Error('403 rate limit'); } });
    assert.equal(r.ok, false);
    assert.match(r.error, /could not be read at main/);
    assert.doesNotMatch(r.error, /403/);
  });
});
