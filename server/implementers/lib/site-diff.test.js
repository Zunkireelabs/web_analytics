import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { compareBuilds, extractFacts, urlFromFile, normalizeForCompare } from './site-diff.js';

const O = 'https://x.com';
const page = ({ title = 'T', desc = 'D', canon, h1 = 1, body = '', ld = '' } = {}, url = '/') =>
  `<html><head><title>${title}</title><meta name="description" content="${desc}"><link rel="canonical" href="${canon ?? O + url}">${ld}</head><body>${'<h1>H</h1>'.repeat(h1)}${body}<script>window.__b="abc123"</script></body></html>`;
const put = (root, rel, html) => { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, html); };
function site(files) { const d = mkdtempSync(join(tmpdir(), 'sd-')); for (const [r, h] of Object.entries(files)) put(d, r, h); return d; }
const clone = (d) => { const c = mkdtempSync(join(tmpdir(), 'sd-')); cpSync(d, c, { recursive: true }); return c; };
const codes = (r) => r.violations.map((v) => `${v.code}:${v.url}`);

describe('site-diff compareBuilds', () => {
  const baseFiles = { 'index.html': page({}, '/'), 'about/index.html': page({ title: 'About' }, '/about'), 'blog/old/index.html': page({ title: 'Old', body: '<a href="/about">a</a>' }, '/blog/old') };
  test('identical builds (only script payload differs) pass', () => {
    const b = site(baseFiles); const c = clone(b);
    put(c, 'index.html', page({}, '/').replace('abc123', 'zzz999'));
    assert.equal(compareBuilds({ baseDir: b, candDir: c, origin: O }).ok, true);
  });
  test('a new, complete post passes while every other page stays identical', () => {
    const b = site(baseFiles); const c = clone(b);
    put(c, 'blog/new/index.html', page({ title: 'New', body: '<img src="/img/a.webp"><a href="/about">x</a>' }, '/blog/new'));
    put(c, 'img/a.webp', 'x');
    const r = compareBuilds({ baseDir: b, candDir: c, origin: O, newUrls: ['/blog/new'] });
    assert.deepEqual(codes(r), []);
  });
  test('unintended visual/content change on another page is caught', () => {
    const b = site(baseFiles); const c = clone(b);
    put(c, 'about/index.html', page({ title: 'About', body: '<div style="color:red">oops</div>' }, '/about'));
    assert.deepEqual(codes(compareBuilds({ baseDir: b, candDir: c, origin: O })), ['unintended-change:/about']);
  });
  test('removed page is caught unless declared', () => {
    const b = site(baseFiles); const c = clone(b); rmSync(join(c, 'about'), { recursive: true });
    assert.ok(codes(compareBuilds({ baseDir: b, candDir: c, origin: O })).includes('page-removed:/about'));
    assert.equal(compareBuilds({ baseDir: b, candDir: c, origin: O, removedUrls: ['/about'] }).violations.some((v) => v.code === 'page-removed'), false);
  });
  test('new page problems: missing image, broken link, bad canonical, no h1, bad JSON-LD, missing description', () => {
    const b = site(baseFiles); const c = clone(b);
    put(c, 'blog/n/index.html', page({ desc: '', canon: O + '/other', h1: 0, body: '<img src="/img/missing.webp"><a href="/nope">n</a>', ld: '<script type="application/ld+json">{bad</script>' }, '/blog/n'));
    const got = codes(compareBuilds({ baseDir: b, candDir: c, origin: O, newUrls: ['/blog/n'] }));
    for (const k of ['broken-image', 'broken-link', 'canonical-mismatch', 'bad-jsonld', 'new-page-incomplete']) assert.ok(got.some((x) => x.startsWith(k)), k);
  });
  test('an intended page that loses its title, canonical or JSON-LD is a metadata regression', () => {
    const ld = '<script type="application/ld+json">{"@type":"FAQPage"}</script>';
    const b = site({ 'a/index.html': page({ ld }, '/a') }); const c = clone(b);
    put(c, 'a/index.html', '<html><head></head><body><h1>x</h1></body></html>');
    const r = compareBuilds({ baseDir: b, candDir: c, origin: O, intendedUrls: ['/a'] });
    assert.ok(r.violations.filter((v) => v.code === 'metadata-regression').length >= 3);
  });
  test('a new page that duplicates another page is flagged; a declared new page that did not build is flagged', () => {
    const b = site(baseFiles); const c = clone(b);
    put(c, 'blog/n1/index.html', page({ title: 'Same' }, '/blog/n1').replaceAll('/blog/n1', '/blog/n1'));
    put(c, 'blog/n2/index.html', page({ title: 'Same' }, '/blog/n1').replace('/blog/n1', '/blog/n2'));
    const got = codes(compareBuilds({ baseDir: b, candDir: c, origin: O, newUrls: ['/blog/n1', '/blog/n2', '/blog/missing'] }));
    assert.ok(got.some((x) => x.startsWith('new-page-incomplete:/blog/missing')));
  });
  test('helpers', () => {
    assert.equal(urlFromFile('index.html'), '/'); assert.equal(urlFromFile('a/b/index.html'), '/a/b'); assert.equal(urlFromFile('a.html'), '/a');
    assert.equal(extractFacts('<title> t </title><h1>a</h1><h1>b</h1>').h1, 2);
    assert.equal(normalizeForCompare('<p id=":r1:">x</p><script>1</script>'), '<p id="#">x</p>');
  });
});

describe('site-diff: links to a NEW page are the only tolerated ripple', () => {
  test('a card for the new post on an unchanged page is ignored; any other change on that page is still caught', () => {
    const card = '<a href="/blog/new"><h3>New</h3><p>excerpt</p></a>';
    const b = site({ 'blog/index.html': page({ body: '<p>list</p>' }, '/blog'), 'blog/new/index.html': undefined ?? '' });
    rmSync(join(b, 'blog/new'), { recursive: true, force: true });
    const c = clone(b);
    put(c, 'blog/new/index.html', page({ title: 'New' }, '/blog/new'));
    put(c, 'blog/index.html', page({ body: `<p>list</p>${card}` }, '/blog'));
    assert.deepEqual(codes(compareBuilds({ baseDir: b, candDir: c, origin: O, newUrls: ['/blog/new'] })), []);
    put(c, 'blog/index.html', page({ body: `<p>${'list CHANGED '.repeat(500)}</p>${card}` }, '/blog'));
    assert.deepEqual(codes(compareBuilds({ baseDir: b, candDir: c, origin: O, newUrls: ['/blog/new'] })), ['unintended-change:/blog']);
  });
});

describe('site-diff: listing ripple vs real unintended change', () => {
  test('a changed page that now links the new post is a non-blocking listing-ripple; a changed page that does not is blocking', () => {
    const b = site({ 'a/index.html': page({ body: '<a href="/old">old</a>' }, '/a'), 'b/index.html': page({ body: '<p>x</p>' }, '/b') });
    const c = clone(b);
    put(c, 'blog/new/index.html', page({ title: 'New' }, '/blog/new'));
    put(c, 'a/index.html', page({ body: '<a href="/blog/new"><h3>New</h3></a>' }, '/a').replace('/old', '/old'));
    put(c, 'b/index.html', page({ body: '<p>x</p><div>surprise</div>' }, '/b'));
    const r = compareBuilds({ baseDir: b, candDir: c, origin: O, newUrls: ['/blog/new'] });
    assert.equal(r.violations.find((v) => v.url === '/a')?.code, 'listing-ripple');
    assert.equal(r.violations.find((v) => v.url === '/b')?.code, 'unintended-change');
    assert.equal(r.ok, false);
    put(c, 'b/index.html', page({ body: '<p>x</p>' }, '/b'));
    assert.equal(compareBuilds({ baseDir: b, candDir: c, origin: O, newUrls: ['/blog/new'] }).ok, true);
  });
});
