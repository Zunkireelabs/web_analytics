import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverPages, scanSite, rankPages, parseSitemap, pageUrl } from './siteScan.js';

const home = (html, url = 'https://www.acme.io/') => async () => ({ html, finalUrl: new URL(url) });
const files = (map) => async (origin, path) => {
  const key = new URL(path, origin).toString();
  return map[key] ? { present: true, content: map[key] } : { present: false, content: null };
};
const urlset = (...locs) => `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;

test('pageUrl keeps same-site pages only, without query, hash or trailing slash', () => {
  const host = 'acme.io';
  assert.equal(pageUrl('/pricing/?utm=1#top', 'https://www.acme.io/', host), 'https://www.acme.io/pricing');
  assert.equal(pageUrl('https://acme.io/', 'https://www.acme.io/', host), 'https://acme.io/');
  assert.equal(pageUrl('https://other.com/x', 'https://www.acme.io/', host), null);
  assert.equal(pageUrl('/logo.png', 'https://www.acme.io/', host), null);
  assert.equal(pageUrl('/brochure.pdf', 'https://www.acme.io/', host), null);
  assert.equal(pageUrl('mailto:hi@acme.io', 'https://www.acme.io/', host), null);
  assert.equal(pageUrl('/wp-admin/x', 'https://www.acme.io/', host), null);
  assert.equal(pageUrl('/login', 'https://www.acme.io/', host), null);
});

test('parseSitemap reads urlsets and sitemap indexes', () => {
  assert.deepEqual(parseSitemap(urlset('https://a.io/1', 'https://a.io/2')).locs, ['https://a.io/1', 'https://a.io/2']);
  const idx = parseSitemap('<sitemapindex><sitemap><loc>https://a.io/s1.xml</loc></sitemap></sitemapindex>');
  assert.equal(idx.isIndex, true);
  assert.deepEqual(idx.locs, ['https://a.io/s1.xml']);
});

test('discovery starts at the entered page, follows a sitemap index one level, adds homepage links, dedupes and caps', async () => {
  const html = '<nav><a href="/about">About</a><a href="/pricing?ref=x">Pricing</a><a href="https://other.com/x">Out</a><a href="/logo.png">img</a><a href="#top">top</a></nav>';
  const many = Array.from({ length: 30 }, (_, i) => `https://www.acme.io/blog/post-${i}`);
  const fetchFile = files({
    'https://www.acme.io/robots.txt': 'User-agent: *\nSitemap: https://www.acme.io/sitemap_index.xml\n',
    'https://www.acme.io/sitemap_index.xml': '<sitemapindex><sitemap><loc>https://www.acme.io/s-pages.xml</loc></sitemap><sitemap><loc>https://www.acme.io/s-images.xml</loc></sitemap></sitemapindex>',
    'https://www.acme.io/s-pages.xml': urlset('https://www.acme.io/', 'https://www.acme.io/pricing', ...many),
  });
  const r = await discoverPages('acme.io', { fetchHome: home(html), fetchFile, limit: 12 });
  assert.equal(r.entry, 'https://www.acme.io/');
  assert.equal(r.pages[0], r.entry);
  assert.equal(r.pages.length, 12);
  assert.equal(new Set(r.pages).size, 12);
  assert.ok(r.pages.includes('https://www.acme.io/about'));
  assert.ok(r.pages.every((u) => u.startsWith('https://www.acme.io/') && !u.includes('?') && !u.endsWith('.png')));
  assert.ok(r.found > 12);
});

test('discovery falls back to /sitemap.xml and to homepage links', async () => {
  const html = '<a href="/a">A</a><a href="/b/">B</a>';
  const r = await discoverPages('https://acme.io', { fetchHome: home(html, 'https://acme.io/'), fetchFile: files({}) });
  assert.deepEqual(r.pages, ['https://acme.io/', 'https://acme.io/a', 'https://acme.io/b']);
});

test('discovery refuses private and internal addresses (the SSRF guard)', async () => {
  for (const bad of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest', 'http://10.0.0.5/', 'http://intranet.local/']) {
    await assert.rejects(() => discoverPages(bad), (err) => err.code === 'invalid_url', bad);
  }
});

// A page report with the given failing checks (id -> points lost, out of 10).
function pageReport(path, lostById, scores = {}) {
  const ids = ['qa-content', 'freshness-signals', 'author-expertise', 'meta-description', 'canonical-tag', 'favicon', 'open-graph'];
  return {
    finalUrl: `https://acme.io${path}`,
    overall: { seo: { score: scores.seo ?? 80 }, aeo: { score: scores.aeo ?? 80 }, geo: { score: scores.geo ?? 80 }, agentic: { score: scores.agentic ?? 80 } },
    pageMetadata: { title: `Page ${path} | Acme`, description: 'd', h1s: ['h'], headings: [{ tag: 'h2', text: 'Why teams switch?' }] },
    checks: ids.map((id) => ({ id, title: id, category: 'seo', maxScore: 10, score: 10 - (lostById[id] || 0), message: `${id} message`, recommendation: `${id} recommendation` })),
  };
}

function fakeSite(reports, { failUrls = [] } = {}) {
  const urls = Object.keys(reports).map((p) => `https://acme.io${p}`);
  return {
    discover: async () => ({ entry: urls[0], pages: urls, found: urls.length + 20, siteHost: 'acme.io' }),
    audit: async (url) => {
      if (failUrls.includes(url)) throw new Error('boom');
      return reports[new URL(url).pathname];
    },
  };
}

test('returns the 10 worst pages, worst first; only the worst 3 carry fixes, the rest are locked', async () => {
  const reports = {};
  for (let i = 0; i < 14; i++) {
    reports[i === 0 ? '/' : `/p${i}`] = pageReport(i === 0 ? '/' : `/p${i}`, { 'qa-content': 9, 'freshness-signals': 8, 'author-expertise': 7, 'meta-description': 5, favicon: 2 }, { seo: 100 - i * 6, aeo: 100 - i * 6, geo: 100 - i * 6, agentic: 100 - i * 6 });
  }
  const events = [];
  const r = await scanSite('acme.io', { ...fakeSite(reports), onProgress: (e) => events.push(e) });
  assert.equal(r.pages.length, 10);
  assert.deepEqual(r.pages.map((p) => p.path), ['/p13', '/p12', '/p11', '/p10', '/p9', '/p8', '/p7', '/p6', '/p5', '/p4']);
  const open = r.pages.slice(0, 3);
  const locked = r.pages.slice(3);
  assert.ok(open.every((p) => !p.locked && p.issues.length === 3 && p.issues.every((i) => i.fix?.code)));
  assert.ok(locked.every((p) => p.locked && p.issues.length === 0 && p.failing > 0));
  assert.equal(r.pages[0].issues[0].id, 'qa-content');
  assert.equal(r.site.pagesAudited, 14);
  assert.equal(r.site.pagesFound, 34);
  assert.equal(r.morePages, 4);
  assert.ok(r.entryReport.finalUrl.endsWith('acme.io/'));
  assert.equal(events[0].type, 'finding');
  assert.equal(events[1].type, 'pages');
  assert.equal(events[1].pages.length, 14);
  assert.equal(events.filter((e) => e.type === 'auditing').length, 14);
  assert.equal(events.filter((e) => e.type === 'audit').length, 14);
  assert.equal(events.at(-1).type, 'audit');
  assert.equal(events.at(-1).done, 14);
});

test('issues without a fix generator still come back with their recommendation, after the fixable ones', async () => {
  const reports = { '/': pageReport('/', { favicon: 9, 'canonical-tag': 3 }) };
  const r = await scanSite('acme.io', fakeSite(reports));
  const issues = r.pages[0].issues;
  assert.equal(issues.length, 2);
  const withFix = issues.filter((i) => i.fix);
  const without = issues.filter((i) => !i.fix);
  assert.ok(without.every((i) => i.recommendation));
  assert.deepEqual(issues.map((i) => !!i.fix), [...withFix, ...without].map((i) => !!i.fix)); // fixable ones first
});

test('a page that fails to load is counted, not fatal; every page failing is an error', async () => {
  const reports = { '/': pageReport('/', { 'qa-content': 9 }), '/a': pageReport('/a', { 'qa-content': 9 }) };
  const r = await scanSite('acme.io', fakeSite(reports, { failUrls: ['https://acme.io/a'] }));
  assert.equal(r.site.pagesFailed, 1);
  assert.equal(r.site.pagesAudited, 1);
  await assert.rejects(() => scanSite('acme.io', fakeSite(reports, { failUrls: ['https://acme.io/', 'https://acme.io/a'] })), (e) => e.code === 'fetch_failed');
});

test('a clean page is not listed as needing fixes', async () => {
  const reports = { '/': pageReport('/', {}), '/a': pageReport('/a', { 'qa-content': 9 }) };
  const r = await scanSite('acme.io', fakeSite(reports));
  assert.deepEqual(r.pages.map((p) => p.path), ['/a']);
  assert.equal(r.site.pagesWithIssues, 1);
});

test('stops starting new pages once the budget is spent or the caller leaves', async () => {
  const reports = {};
  for (let i = 0; i < 6; i++) reports[`/p${i}`] = pageReport(`/p${i}`, { 'qa-content': 9 });
  let calls = 0;
  const site = fakeSite(reports);
  const audit = async (...a) => { calls += 1; return site.audit(...a); };
  await assert.rejects(() => scanSite('acme.io', { ...site, audit, shouldStop: () => true }), (e) => e.code === 'fetch_failed');
  assert.equal(calls, 0);
  calls = 0;
  const slow = async (...a) => { calls += 1; await new Promise((r) => setTimeout(r, 30)); return site.audit(...a); };
  const r = await scanSite('acme.io', { ...site, audit: slow, concurrency: 1, budgetMs: 50 });
  assert.ok(calls < 6 && r.site.pagesAudited === calls);
  assert.ok(r.site.pagesSkipped > 0);
});

test('rankPages orders by score, then by points lost', () => {
  const a = { report: pageReport('/a', { 'qa-content': 9 }, { seo: 50, aeo: 50, geo: 50, agentic: 50 }) };
  const b = { report: pageReport('/b', { 'qa-content': 9, favicon: 9 }, { seo: 50, aeo: 50, geo: 50, agentic: 50 }) };
  const c = { report: pageReport('/c', {}, { seo: 20, aeo: 20, geo: 20, agentic: 20 }) };
  assert.deepEqual(rankPages([a, b, c]).map((p) => new URL(p.report.finalUrl).pathname), ['/c', '/b', '/a']);
});
