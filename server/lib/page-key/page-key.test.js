import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizePage, canonicalPageKey, splitPageKey, bareHost, isWwwAlias } from './canonical.js';
import { buildDuplicateReport, formatReport } from './duplicate-report.js';

const HOST = 'example.com';

describe('canonicalizePage: what it may and may not change', () => {
  test('the path is kept exactly: /About and /about are different pages', () => {
    assert.equal(canonicalizePage('https://example.com/About', { canonicalHost: HOST }).key, 'https://example.com/About');
    assert.notEqual(canonicalizePage('https://example.com/About', { canonicalHost: HOST }).key, canonicalizePage('https://example.com/about', { canonicalHost: HOST }).key);
  });
  test('www is removed ONLY when it is an alias of the project\'s own domain', () => {
    assert.equal(canonicalizePage('https://www.example.com/a', { canonicalHost: HOST }).key, 'https://example.com/a');
    assert.deepEqual(canonicalizePage('https://www.example.com/a', { canonicalHost: HOST }).changes, ['www']);
    // no domain evidence: untouched
    assert.equal(canonicalizePage('https://www.example.com/a').key, 'https://www.example.com/a');
    // a different domain is never treated as an alias, even with a www
    assert.equal(canonicalizePage('https://www.other.com/a', { canonicalHost: HOST }).key, 'https://www.other.com/a');
    // a subdomain is not an alias
    assert.equal(canonicalizePage('https://www.blog.example.com/a', { canonicalHost: HOST }).key, 'https://www.blog.example.com/a');
  });
  test('the project domain may be written with a scheme or www; the test still works', () => {
    assert.equal(bareHost('https://www.Example.com/'), 'example.com');
    assert.equal(isWwwAlias('www.example.com', 'https://www.example.com/'), true);
    assert.equal(isWwwAlias('shop.example.com', 'example.com'), false);
  });
  test('a fragment is dropped', () => {
    assert.deepEqual(canonicalizePage('https://example.com/a#team', { canonicalHost: HOST }), { url: true, key: 'https://example.com/a', changes: ['fragment'] });
  });
  test('tracking parameters are dropped but meaningful ones are kept', () => {
    const c = canonicalizePage('https://example.com/a?utm_source=x&page=2&gclid=abc&lang=ne', { canonicalHost: HOST });
    assert.equal(c.key, 'https://example.com/a?lang=ne&page=2');
    assert.deepEqual(c.changes.sort(), ['query-order', 'tracking'].sort());
    assert.equal(canonicalizePage('https://example.com/a?id=7', { canonicalHost: HOST }).key, 'https://example.com/a?id=7', 'a meaningful parameter alone is untouched');
  });
  test('parameter order does not make two pages', () => {
    assert.equal(canonicalizePage('https://example.com/a?b=2&a=1').key, canonicalizePage('https://example.com/a?a=1&b=2').key);
  });
  test('an untouched URL comes back byte for byte, and with no changes', () => {
    const c = canonicalizePage('https://example.com/a/b?x=1');
    assert.deepEqual(c, { url: true, key: 'https://example.com/a/b?x=1', changes: [] });
  });
  test('trailing slash and scheme are NOT merged unless asked', () => {
    assert.equal(canonicalizePage('https://example.com/a/').key, 'https://example.com/a/');
    assert.equal(canonicalizePage('https://example.com/a/', { trailingSlash: true }).key, 'https://example.com/a');
    assert.equal(canonicalizePage('https://example.com/', { trailingSlash: true }).key, 'https://example.com/', 'the root is never stripped');
    assert.equal(canonicalizePage('http://example.com/a').key, 'http://example.com/a');
    assert.equal(canonicalizePage('http://example.com/a', { scheme: true }).key, 'https://example.com/a');
  });
  test('anything that is not an absolute URL is returned unchanged', () => {
    for (const v of ['', 'analytics:ga4', 'topic::how to', '/relative/path', 'blog:slug', 'landing::nepal']) {
      assert.deepEqual(canonicalizePage(v), { url: false, key: v, changes: [] });
    }
  });
});

describe('composite keys: only the page part is touched', () => {
  const opts = { canonicalHost: HOST };
  test('expand-content (page::focus) keeps its focus', () => {
    assert.equal(canonicalPageKey('https://www.example.com/a#x::pricing', opts).key, 'https://example.com/a::pricing');
  });
  test('broken-link-fix (page::href) keeps the href exactly, even when it looks normalizable', () => {
    assert.equal(canonicalPageKey('https://www.example.com/a::https://www.other.com/b#frag', opts).key, 'https://example.com/a::https://www.other.com/b#frag');
  });
  test('redirect-add (redirect::from) is normalized on the from URL', () => {
    assert.equal(canonicalPageKey('redirect::https://www.example.com/old#x', opts).key, 'redirect::https://example.com/old');
  });
  test('content-integrity-repair keeps fixType, section and role', () => {
    assert.equal(canonicalPageKey('https://www.example.com/a::malformed-table::2::heading', opts).key, 'https://example.com/a::malformed-table::2::heading');
  });
  test('keys with no page in them are left alone', () => {
    for (const k of ['topic::x', 'landing::nepal', 'comparison::a-vs-b', 'blog-image::content/blog/x.md', 'analytics:ga4', '']) assert.equal(splitPageKey(k), null);
  });
});

const rec = (id, site, type, page, extra = {}) => ({ id, site_id: site, recommendation_type: type, page, status: 'open', detecting_agents: ['a'], supporting_agents: [], finding_ids: [`f${id}`], first_detected_at: '2026-11-01', ...extra });
const sites = [{ id: 1, name: 'A', website_domain: 'example.com' }, { id: 2, name: 'B', website_domain: 'other.org' }];

describe('duplicate report', () => {
  test('rows that differ only by a safe rule collide at the "safe" level, and the oldest is the one kept', () => {
    const r = buildDuplicateReport({ sites, recommendations: [
      rec(10, 1, 'meta-title', 'https://www.example.com/about/'.replace('/about/', '/about')),
      rec(11, 1, 'meta-title', 'https://example.com/about#team', { detecting_agents: ['analyst-insights'] }),
    ] });
    assert.equal(r.collisions.length, 1);
    assert.equal(r.collisions[0].level, 'safe');
    assert.equal(r.collisions[0].keep, 10);
    assert.deepEqual(r.collisions[0].foldIn, [11]);
  });
  test('a trailing slash needs a decision and is reported at its own level', () => {
    const r = buildDuplicateReport({ sites, recommendations: [rec(1, 1, 'meta-title', 'https://example.com/a'), rec(2, 1, 'meta-title', 'https://example.com/a/')] });
    assert.equal(r.collisions[0].level, 'trailing-slash');
    assert.match(r.collisions[0].decisionNeeded, /decide/);
  });
  test('http vs https is reported at the scheme level', () => {
    const r = buildDuplicateReport({ sites, recommendations: [rec(1, 1, 'meta-title', 'http://example.com/a'), rec(2, 1, 'meta-title', 'https://example.com/a')] });
    assert.equal(r.collisions[0].level, 'scheme');
  });
  test('www on a domain that is NOT the project\'s own is held back as unverified', () => {
    const r = buildDuplicateReport({ sites, recommendations: [rec(1, 2, 'meta-title', 'https://www.cdn-partner.com/a'), rec(2, 2, 'meta-title', 'https://cdn-partner.com/a')] });
    assert.equal(r.collisions[0].level, 'www-unverified');
  });
  test('DIFFERENT fix types on one page are never a collision (independent issues stay independent)', () => {
    const r = buildDuplicateReport({ sites, recommendations: [rec(1, 1, 'meta-title', 'https://example.com/a'), rec(2, 1, 'schema', 'https://example.com/a'), rec(3, 1, 'expand-content', 'https://example.com/a::pricing')] });
    assert.equal(r.collisions.length, 0);
  });
  test('the same page on DIFFERENT projects is never a collision', () => {
    const r = buildDuplicateReport({ sites, recommendations: [rec(1, 1, 'meta-title', 'https://example.com/a'), rec(2, 2, 'meta-title', 'https://example.com/a')] });
    assert.equal(r.collisions.length, 0);
  });
  test('different meaningful query parameters stay different pages', () => {
    const r = buildDuplicateReport({ sites, recommendations: [rec(1, 1, 'meta-title', 'https://example.com/list?page=1'), rec(2, 1, 'meta-title', 'https://example.com/list?page=2')] });
    assert.equal(r.collisions.length, 0);
  });
  test('different path case stays different', () => {
    const r = buildDuplicateReport({ sites, recommendations: [rec(1, 1, 'meta-title', 'https://example.com/About'), rec(2, 1, 'meta-title', 'https://example.com/about')] });
    assert.equal(r.collisions.length, 0);
  });
  test('expand-content on one page with different focus stays two recommendations', () => {
    const r = buildDuplicateReport({ sites, recommendations: [rec(1, 1, 'expand-content', 'https://example.com/a::pricing'), rec(2, 1, 'expand-content', 'https://www.example.com/a::features')] });
    assert.equal(r.collisions.length, 0);
  });
  test('only OPEN rows are compared, matching the database\'s unique index', () => {
    const r = buildDuplicateReport({ sites, recommendations: [rec(1, 1, 'meta-title', 'https://example.com/a'), rec(2, 1, 'meta-title', 'https://www.example.com/a', { status: 'closed' })] });
    assert.equal(r.collisions.length, 0);
  });
  test('it counts drafts attached to the rows a merge would fold in, so the plan can see what would need re-pointing', () => {
    const r = buildDuplicateReport({ sites, draftCounts: new Map([[11, 1]]), recommendations: [rec(10, 1, 'meta-title', 'https://example.com/a'), rec(11, 1, 'meta-title', 'https://www.example.com/a')] });
    assert.equal(r.totals.draftsOnFoldedRows, 1);
  });
  test('non-URL keys are left alone and counted', () => {
    const r = buildDuplicateReport({ sites, recommendations: [rec(1, 1, 'blog-outline', 'topic::how to'), rec(2, 1, 'analytics-install', 'analytics:ga4')] });
    assert.equal(r.totals.notUrlKeyed, 2);
    assert.equal(r.totals.urlKeyed, 0);
  });
  test('the printed report names ids, sites, original and normalized URLs and fix types', () => {
    const r = buildDuplicateReport({ sites, recommendations: [rec(10, 1, 'meta-title', 'https://example.com/about'), rec(11, 1, 'meta-title', 'https://www.example.com/about?utm_source=x#t', { detecting_agents: ['analyst-insights'] })] });
    const text = formatReport(r);
    for (const needle of ['#10', '#11', 'site 1', 'meta-title', 'https://www.example.com/about?utm_source=x#t', 'https://example.com/about', 'analyst-insights']) assert.ok(text.includes(needle), needle);
  });
});
