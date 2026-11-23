import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDrift, pickPages, changedByUs, buildFinding, capturePage, MAX_PAGES } from './seo-drift-runner.js';

const U1 = 'https://example.com/a/';
const U2 = 'https://example.com/b/';
const T0 = '2026-11-01T00:00:00Z';
const good = (over = {}) => ({
  statusCode: 200, title: 'Title', metaDescription: 'Desc', canonical: 'https://example.com/a/', robots: null,
  h1: ['Heading'], h2: [], schemaTypes: ['Article'], schemaHash: 'h', openGraph: { 'og:title': 'x' }, contentHash: 'c', wordCount: 100, ...over,
});

// A fake world: baselines in memory, a capture function that returns whatever the test says, a log of what was stored.
function world({ baselines = {}, captures = {}, own = new Map() } = {}) {
  const stored = []; let ownAskedSince = null;
  const deps = {
    getBaselines: async (_s, urls) => new Map(urls.filter((u) => baselines[u]).map((u) => [u, { capturedAt: T0, ...baselines[u] }])),
    capture: async (url) => (captures[url] instanceof Error ? { ok: false, error: 'timeout' } : { ok: true, snap: captures[url] }),
    insertSnapshot: async (siteId, url, snap, opts) => { stored.push({ siteId, url, snap, ...opts }); },
    pruneSnapshots: async () => {},
    ownChangesSince: async (_s, since) => { ownAskedSince = since; return own; },
  };
  return { deps, stored, ownAsked: () => ownAskedSince };
}

describe('baselines', () => {
  test('the first capture of a page becomes its baseline and reports nothing', async () => {
    const w = world({ captures: { [U1]: good() } });
    const r = await runDrift({ siteId: 1, pages: [U1], deps: w.deps });
    assert.equal(r.firstCaptures, 1);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(w.stored.map((s) => s.baselineReason), ['first-capture']);
  });

  test('an unchanged page reports nothing and is stored as a plain capture, not a new baseline', async () => {
    const w = world({ baselines: { [U1]: good() }, captures: { [U1]: good() } });
    const r = await runDrift({ siteId: 1, pages: [U1], deps: w.deps });
    assert.deepEqual(r.findings, []);
    assert.equal(w.stored[0].baselineReason, undefined);
    assert.equal(r.pagesChecked, 1);
  });
});

describe('regressions are reported', () => {
  test('noindex added becomes one high-priority report-only finding naming the page and what changed', async () => {
    const w = world({ baselines: { [U1]: good() }, captures: { [U1]: good({ robots: 'noindex' }) } });
    const r = await runDrift({ siteId: 1, pages: [U1], impressionsByPage: new Map([[U1, 900]]), deps: w.deps });
    assert.equal(r.findings.length, 1);
    const f = r.findings[0];
    assert.equal(f.id, `seo-drift:page:${U1}`);
    assert.equal(f.priority, 'high');
    assert.equal(f.recommendedAction, null);
    assert.equal(f.reportOnly.kind, 'seo-drift');
    assert.equal(f.reportOnly.page, U1);
    assert.match(f.whyItMatters, /\/a\/ has changed since 2026-11-01/);
    assert.equal(f.expectedImpact.value, 900);
    assert.ok(f.evidence.changes.some((c) => c.rule === 'noindex-added'));
  });

  test('a title change alone is medium priority; several changes on one page are ONE finding', async () => {
    const w = world({ baselines: { [U1]: good() }, captures: { [U1]: good({ title: 'New Title', metaDescription: 'New desc' }) } });
    const r = await runDrift({ siteId: 1, pages: [U1], deps: w.deps });
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].priority, 'medium');
    assert.deepEqual(r.findings[0].evidence.changes.map((c) => c.rule).sort(), ['description-changed', 'title-changed']);
  });

  test('info-level changes (text, subheadings) are recorded in the history and never reported', async () => {
    const w = world({ baselines: { [U1]: good() }, captures: { [U1]: good({ contentHash: 'c2', h2: ['New section'] }) } });
    const r = await runDrift({ siteId: 1, pages: [U1], deps: w.deps });
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.history[0].changes.map((c) => c.rule).sort(), ['content-changed', 'subheadings-changed']);
  });

  test('a page that now errors is ONE finding (its error page\'s title and headings are not "changes")', async () => {
    const w = world({ baselines: { [U1]: good() }, captures: { [U1]: good({ statusCode: 404, title: 'Not found', h1: ['404'], metaDescription: null, canonical: null }) } });
    const r = await runDrift({ siteId: 1, pages: [U1], deps: w.deps });
    assert.equal(r.findings.length, 1);
    assert.deepEqual(r.findings[0].evidence.changes.map((c) => c.rule), ['page-error']);
  });

  test('the baseline stays put while a regression is open (so it keeps being reported until fixed)', async () => {
    const w = world({ baselines: { [U1]: good() }, captures: { [U1]: good({ robots: 'noindex' }) } });
    await runDrift({ siteId: 1, pages: [U1], deps: w.deps });
    assert.equal(w.stored[0].baselineReason, undefined);
  });
});

describe('our own changes', () => {
  const own = (when) => new Map([['/a/', new Date(when)]]);

  test('a title change after a fix of OURS on that page is expected: not reported, baseline moves forward', async () => {
    const w = world({ baselines: { [U1]: good() }, captures: { [U1]: good({ title: 'Better title' }) }, own: own('2026-11-10T00:00:00Z') });
    const r = await runDrift({ siteId: 1, pages: [U1], deps: w.deps });
    assert.deepEqual(r.findings, []);
    assert.equal(r.suppressedOwnChanges, 1);
    assert.equal(w.stored[0].baselineReason, 'own-change');
  });

  test('...but a CRITICAL change is still reported, even then: our fix may be what broke it', async () => {
    const w = world({ baselines: { [U1]: good() }, captures: { [U1]: good({ title: 'Better title', schemaTypes: [], schemaHash: null }) }, own: own('2026-11-10T00:00:00Z') });
    const r = await runDrift({ siteId: 1, pages: [U1], deps: w.deps });
    assert.equal(r.findings.length, 1);
    assert.deepEqual(r.findings[0].evidence.changes.map((c) => c.rule), ['schema-removed'], 'only the alarming part, not the expected title change');
    assert.equal(w.stored[0].baselineReason, undefined, 'baseline stays so the regression keeps showing');
  });

  test('a fix of ours made BEFORE the baseline explains nothing', async () => {
    const w = world({ baselines: { [U1]: good() }, captures: { [U1]: good({ title: 'Changed by someone else' }) }, own: own('2026-10-01T00:00:00Z') });
    const r = await runDrift({ siteId: 1, pages: [U1], deps: w.deps });
    assert.equal(r.findings.length, 1);
  });

  test('a fix of ours on a DIFFERENT page explains nothing here', async () => {
    const w = world({ baselines: { [U1]: good() }, captures: { [U1]: good({ title: 'Changed' }) }, own: new Map([['/other/', new Date('2026-11-10T00:00:00Z')]]) });
    const r = await runDrift({ siteId: 1, pages: [U1], deps: w.deps });
    assert.equal(r.findings.length, 1);
  });

  test('our-changes are only looked up when something non-info differs', async () => {
    const w = world({ baselines: { [U1]: good() }, captures: { [U1]: good() } });
    await runDrift({ siteId: 1, pages: [U1], deps: w.deps });
    assert.equal(w.ownAsked(), null);
  });
});

describe('unreachable and mixed runs', () => {
  test('an unreachable page is skipped: not reported, not stored, not in checkedPages', async () => {
    const w = world({ baselines: { [U1]: good() }, captures: { [U1]: new Error('x'), [U2]: good() } });
    const r = await runDrift({ siteId: 1, pages: [U1, U2], deps: w.deps });
    assert.equal(r.unverifiable, 1);
    assert.deepEqual(r.checkedPages, [U2]);
    assert.equal(w.stored.some((s) => s.url === U1), false);
  });

  test('every page is judged on its own', async () => {
    const w = world({ baselines: { [U1]: good(), [U2]: good() }, captures: { [U1]: good(), [U2]: good({ canonical: null }) } });
    const r = await runDrift({ siteId: 1, pages: [U1, U2], deps: w.deps });
    assert.deepEqual(r.findings.map((f) => f.reportOnly.page), [U2]);
    assert.deepEqual(r.checkedPages, [U1, U2]);
  });

  test('everything is scoped to the given site', async () => {
    const w = world({ captures: { [U1]: good() } });
    await runDrift({ siteId: 42, pages: [U1], deps: w.deps });
    assert.equal(w.stored[0].siteId, 42);
  });
});

describe('pickPages', () => {
  test('home page first, then the most-seen pages; de-duplicated, tracking stripped, capped, non-http dropped', () => {
    const pages = pickPages({ site: { website_domain: 'example.com' }, topPages: ['https://example.com/', 'https://example.com/a/?utm_source=x', 'https://example.com/a/', 'mailto:x@y.z', 'not a url', 'https://example.com/b/'], max: 3 });
    assert.deepEqual(pages, ['https://example.com/', 'https://example.com/a/', 'https://example.com/b/']);
  });
  test('works with no domain on the project, and with none of either', () => {
    assert.deepEqual(pickPages({ site: {}, topPages: ['https://example.com/a/'] }), ['https://example.com/a/']);
    assert.deepEqual(pickPages({ site: null, topPages: [] }), []);
  });
  test('the default cap is the documented one', () => assert.equal(pickPages({ site: {}, topPages: Array.from({ length: 60 }, (_, i) => `https://example.com/p${i}/`) }).length, MAX_PAGES));
});

describe('changedByUs', () => {
  const at = new Date('2026-11-10T00:00:00Z');
  test('matches the draft\'s page however it was written', () => {
    for (const key of ['https://example.com/a/', '/a/', '/a', 'https://example.com/a']) {
      assert.equal(changedByUs(U1, T0, new Map([[key, at]])), true, key);
    }
  });
  test('only counts fixes made after the baseline', () => {
    assert.equal(changedByUs(U1, '2026-11-20T00:00:00Z', new Map([['/a/', at]])), false);
    assert.equal(changedByUs(U1, T0, new Map()), false);
  });
});

describe('buildFinding', () => {
  test('quotes was/now, and says whether it can cost rankings', () => {
    const f = buildFinding({ url: U1, baseline: { capturedAt: T0 }, changes: [{ rule: 'title-changed', severity: 'warning', what: 'Page title', was: 'Old', now: 'New', message: 'm' }] });
    assert.match(f.whyItMatters, /Page title: was "Old", now "New"/);
    assert.match(f.whyItMatters, /in case it was not intended/);
    const c = buildFinding({ url: U1, baseline: { capturedAt: T0 }, changes: [{ rule: 'noindex-added', severity: 'critical', what: 'Search visibility', was: null, now: 'noindex', message: 'It will drop out.' }] });
    assert.match(c.whyItMatters, /It will drop out\./);
    assert.match(c.whyItMatters, /cost the page its place in search/);
  });
});

describe('capturePage', () => {
  const fakeFollow = (status, type, body) => async () => ({
    res: { status, headers: new Map([['content-type', type]]), text: async () => body, body: { cancel: async () => {} } },
    finalUrl: new URL('https://example.com/a/'),
  });
  test('reads an HTML page into a snapshot', async () => {
    const r = await capturePage(U1, { follow: fakeFollow(200, 'text/html; charset=utf-8', '<html><head><title>Hi</title></head><body><h1>H</h1></body></html>') });
    assert.equal(r.ok, true); assert.equal(r.snap.title, 'Hi'); assert.equal(r.snap.statusCode, 200);
  });
  test('an error status with a non-HTML body is still captured (that is the point)', async () => {
    const r = await capturePage(U1, { follow: fakeFollow(500, 'application/json', '{}') });
    assert.equal(r.ok, true); assert.equal(r.snap.statusCode, 500); assert.equal(r.snap.title, null);
  });
  test('a blocked or unreachable page returns ok:false, never throws', async () => {
    const r = await capturePage(U1, { follow: async () => { throw Object.assign(new Error('blocked'), { code: 'invalid_url' }); } });
    assert.deepEqual(r, { ok: false, error: 'invalid_url' });
  });
});
