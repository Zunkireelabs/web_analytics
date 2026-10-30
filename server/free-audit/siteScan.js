import * as cheerio from 'cheerio';
import { fetchMainPage, fetchSiblingFile, normalizeUrl, AuditError } from './fetchPage.js';
import { runAudit } from './runAudit.js';
import { fixFor } from './fixes.js';

// Page Fixer: give it a website and it finds the site's pages, audits a sample of them, and
// returns the ten pages with the most to fix. The three worst get their three highest-impact fixes; the other
// seven come back as a locked row (score and issue count only), so their fixes never leave the server.
//
// Every outbound request goes through the same SSRF guard as the single-page audit
// (fetchPage.js -> urlGuard.js): the entry page, robots.txt, sitemaps and each audited page.
// Nothing here fetches a URL that did not come from the visitor's own site (same host only).

const MAX_PAGES = 20;           // candidate pages audited per scan
const TOP_PAGES = 10;           // pages returned
const OPEN_PAGES = 3;           // of those, the worst pages that get their fixes; the rest are locked
const FIXES_PER_PAGE = 3;
const CONCURRENCY = 3;
const BUDGET_MS = 40_000;       // total time spent auditing pages (after discovery)
const PAGE_TIMEOUT_MS = 15_000; // one page
const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_SITEMAPS = 3;         // sitemap files read (robots.txt lists, then one level of an index)
const WEIGHTS = { seo: 0.4, aeo: 0.25, geo: 0.25, agentic: 0.1 };

const ASSET_EXT = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|css|js|mjs|json|xml|txt|pdf|zip|gz|rar|mp3|mp4|mov|avi|webm|woff2?|ttf|eot|docx?|xlsx?|pptx?|csv|rss|atom)$/i;
const SKIP_PATH = /^\/(?:wp-admin|wp-json|wp-login|wp-content|cart|checkout|account|my-account|login|logout|signin|signup|register|admin|feed|cdn-cgi|api)(?:\/|$)/i;

const hostKey = (hostname) => hostname.toLowerCase().replace(/^www\./, '');

// A comparable form of a page URL, or null when it is not an ordinary same-site page.
// Drops the hash and query string, lowercases the host, trims the trailing slash.
function pageUrl(href, base, siteHost) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (hostKey(u.hostname) !== siteHost) return null;
  if (u.username || u.password) return null;
  if (ASSET_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) return null;
  u.hash = '';
  u.search = '';
  u.hostname = u.hostname.toLowerCase();
  let out = u.toString();
  if (u.pathname !== '/' && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

function parseSitemap(xml) {
  const text = String(xml || '');
  const locs = [...text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s][^<\]]*?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].trim());
  return { isIndex: /<sitemapindex[\s>]/i.test(text), locs };
}

function extractLinks(html, base, siteHost) {
  const $ = cheerio.load(html || '');
  const out = [];
  // Navigation and header links first: they are the pages the site itself treats as important.
  $('nav a[href], header a[href], main a[href], a[href]').each((_, el) => {
    const u = pageUrl($(el).attr('href'), base, siteHost);
    if (u) out.push(u);
  });
  return out;
}

// n items spread evenly across the list (so a sitemap of 400 URLs yields pages from different sections).
function spread(list, n) {
  if (list.length <= n) return list.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor((i * list.length) / n)]);
  return out;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new AuditError('timeout', message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Finds up to `limit` pages of the site: the entered page first, then pages from the sitemap(s),
// then internal links from the entered page. `fetchHome` and `fetchFile` are injectable for tests.
async function discoverPages(inputUrl, { limit = MAX_PAGES, fetchHome = fetchMainPage, fetchFile = fetchSiblingFile } = {}) {
  const start = normalizeUrl(inputUrl);
  const home = await fetchHome(start);
  const finalUrl = home.finalUrl;
  const siteHost = hostKey(finalUrl.hostname);
  const origin = finalUrl.origin;
  const entry = pageUrl(finalUrl.toString(), finalUrl, siteHost) || finalUrl.toString();

  // Sitemaps: those named in robots.txt, else /sitemap.xml.
  const robots = await fetchFile(origin, '/robots.txt');
  const sitemapQueue = [];
  if (robots?.present && robots.content) {
    for (const line of robots.content.split(/\r?\n/)) {
      const m = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) {
        const u = pageUrlLoose(m[1], finalUrl, siteHost);
        if (u && !sitemapQueue.includes(u)) sitemapQueue.push(u);
      }
    }
  }
  if (!sitemapQueue.length) sitemapQueue.push(new URL('/sitemap.xml', origin).toString());

  const sitemapPages = [];
  const seenSitemaps = new Set();
  let read = 0;
  while (sitemapQueue.length && read < MAX_SITEMAPS) {
    const url = sitemapQueue.shift();
    if (seenSitemaps.has(url)) continue;
    seenSitemaps.add(url);
    read += 1;
    const file = await fetchFile(origin, url);
    if (!file?.present || !file.content) continue;
    const { isIndex, locs } = parseSitemap(file.content);
    if (isIndex) {
      // One level of index: queue the child sitemaps (skip image/video ones), same host only.
      for (const loc of locs) {
        const u = pageUrlLoose(loc, finalUrl, siteHost);
        if (u && !/image|video|news/i.test(u) && !seenSitemaps.has(u)) sitemapQueue.push(u);
      }
    } else {
      for (const loc of locs) {
        const u = pageUrl(loc, finalUrl, siteHost);
        if (u) sitemapPages.push(u);
      }
    }
  }

  const linkPages = extractLinks(home.html, finalUrl, siteHost);

  const seen = new Set([entry]);
  const pages = [entry];
  const take = (list, max) => {
    for (const u of list) {
      if (pages.length >= limit || max <= 0) break;
      if (seen.has(u)) continue;
      seen.add(u);
      pages.push(u);
      max -= 1;
    }
  };
  const uniqueSitemap = [...new Set(sitemapPages)].filter((u) => u !== entry);
  const uniqueLinks = [...new Set(linkPages)].filter((u) => u !== entry);
  take(spread(uniqueSitemap, 8), 8);
  take(uniqueLinks, limit);
  take(uniqueSitemap, limit); // top up from the sitemap when the homepage links few pages

  const found = new Set([entry, ...uniqueSitemap, ...uniqueLinks]).size;
  return { entry, pages, found, siteHost };
}

// A sitemap URL (it may end in .xml, which pageUrl would reject as an asset): same site only.
function pageUrlLoose(href, base, siteHost) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || hostKey(u.hostname) !== siteHost || u.username || u.password) return null;
  u.hash = '';
  return u.toString();
}

function severity(lost) {
  return lost >= 8 ? 'High' : lost >= 4 ? 'Medium' : 'Low';
}

function overallScore(overall) {
  let sum = 0;
  let weight = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    if (overall?.[k]) { sum += overall[k].score * w; weight += w; }
  }
  return weight ? Math.round(sum / weight) : 0;
}

function gradeOf(n) {
  return n >= 90 ? 'A' : n >= 75 ? 'B' : n >= 60 ? 'C' : n >= 40 ? 'D' : 'F';
}

// The page's failing checks, biggest loss first.
function failingChecks(report) {
  return (report.checks || [])
    .filter((c) => c.maxScore > 0 && c.score < c.maxScore)
    .map((c) => ({ ...c, lost: c.maxScore - c.score, severity: severity(c.maxScore - c.score) }))
    .sort((a, b) => b.lost - a.lost);
}

// The three fixes for a page: the highest-impact failing checks we can write real code for,
// then (if fewer than three) the highest-impact ones that only get a recommendation.
function pickFixes(report, failing, n = FIXES_PER_PAGE) {
  const withFix = [];
  const without = [];
  for (const c of failing) {
    const fix = fixFor(c, report);
    const issue = {
      id: c.id, title: c.title, category: c.category, severity: c.severity,
      message: c.message, recommendation: c.recommendation || null, fix: fix || null,
    };
    (fix ? withFix : without).push(issue);
  }
  return [...withFix, ...without].slice(0, n);
}

function pathOf(url) {
  try { const u = new URL(url); return u.pathname + (u.search || ''); } catch { return url; }
}

// Ranks audited pages: lowest score first, then the most total points lost.
function rankPages(audited) {
  return audited
    .map((a) => {
      const failing = failingChecks(a.report);
      return {
        report: a.report,
        failing,
        score: overallScore(a.report.overall),
        lost: failing.reduce((s, c) => s + c.lost, 0),
      };
    })
    .sort((a, b) => a.score - b.score || b.lost - a.lost);
}

// Runs the whole scan. `onProgress(event)` receives { type: 'finding' | 'pages' | 'auditing' | 'audit', ... };
// `{type:'auditing',url}` fires as each page starts; `shouldStop()` lets the caller abort (client went away). `discover` and `audit` are injectable for tests.
async function scanSite(inputUrl, {
  limit = MAX_PAGES, top = TOP_PAGES, open = OPEN_PAGES, fixes = FIXES_PER_PAGE, concurrency = CONCURRENCY,
  budgetMs = BUDGET_MS, pageTimeoutMs = PAGE_TIMEOUT_MS, discoveryTimeoutMs = DISCOVERY_TIMEOUT_MS,
  onProgress = () => {}, shouldStop = () => false,
  discover = discoverPages, audit = runAudit,
} = {}) {
  onProgress({ type: 'finding' });
  const found = await withTimeout(discover(inputUrl, { limit }), discoveryTimeoutMs, 'Finding the site\'s pages took too long.');
  const { pages, entry } = found;
  onProgress({ type: 'pages', total: pages.length, found: found.found ?? pages.length, pages });

  const siteCache = new Map();
  const deadline = Date.now() + budgetMs;
  const audited = [];
  let failed = 0;
  let done = 0;
  let next = 0;

  async function worker() {
    while (next < pages.length) {
      if (shouldStop() || Date.now() > deadline) return;
      const url = pages[next];
      next += 1;
      onProgress({ type: 'auditing', url, done, total: pages.length });
      try {
        const report = await withTimeout(audit(url, { renderMode: 'raw', siteCache }), pageTimeoutMs, 'That page took too long.');
        audited.push({ url, report });
        done += 1;
        onProgress({ type: 'audit', done, total: pages.length, url, ok: true });
      } catch {
        failed += 1;
        done += 1;
        onProgress({ type: 'audit', done, total: pages.length, url, ok: false });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, worker));

  if (!audited.length) {
    throw new AuditError('fetch_failed', 'We could not read any pages on that site. Check the address and try again.');
  }

  const ranked = rankPages(audited);
  const withIssues = ranked.filter((p) => p.failing.length > 0);
  const worst = withIssues.slice(0, top);
  const average = Math.round(ranked.reduce((s, p) => s + p.score, 0) / ranked.length);
  const entryAudit = audited.find((a) => a.url === entry) || audited[0];

  return {
    site: {
      host: found.siteHost,
      entry,
      pagesFound: found.found ?? pages.length,
      pagesAudited: audited.length,
      pagesSkipped: Math.max(0, pages.length - audited.length - failed),
      pagesFailed: failed,
      averageScore: average,
      averageGrade: gradeOf(average),
      pagesWithIssues: withIssues.length,
    },
    pages: worst.map((p, i) => ({
      url: p.report.finalUrl,
      path: pathOf(p.report.finalUrl),
      title: p.report.pageMetadata?.title || null,
      score: p.score,
      grade: gradeOf(p.score),
      failing: p.failing.length,
      locked: i >= open,
      issues: i < open ? pickFixes(p.report, p.failing, fixes) : [],
    })),
    morePages: Math.max(0, withIssues.length - worst.length),
    // For saving the free report behind the email unlock (not sent to the client).
    entryReport: entryAudit.report,
  };
}

export {
  discoverPages, scanSite, rankPages, pickFixes, failingChecks, overallScore, parseSitemap, pageUrl,
  MAX_PAGES, TOP_PAGES, OPEN_PAGES, FIXES_PER_PAGE, BUDGET_MS,
};
