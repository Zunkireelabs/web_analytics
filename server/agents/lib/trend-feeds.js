import * as cheerio from 'cheerio';

// Free, keyless news/RSS sources for Trend Radar (agents/trend-radar.js).
// Chosen over a paid trends API on purpose: a feed gives real, dated,
// linkable headlines — something a topic can cite — and costs nothing. It
// does NOT give search demand, so trend-radar reports demand as unverified
// (see providers/search-demand/) rather than implying it.
//
// Keyed by industry keyword, never by site id: a new tenant maps onto this
// table through its own industry (tenantIndustries), no per-client code.
// Every URL here was confirmed to return 200 + XML on 2026-10-02; feeds do
// rot, so fetchFeed failures are tolerated per-feed (see fetchAllFeeds).
export const FEED_CATALOG = [
  {
    key: 'technology',
    // Horizontal: tech news is relevant to almost any software-touching
    // business, so it leads only when nothing more specific matches. For a
    // spa-booking product the spa/fitness feeds lead and tech is capped at
    // SECONDARY_FEEDS_PER_CATEGORY — otherwise four high-volume tech feeds
    // would swamp the niche ones.
    horizontal: true,
    match: (s) => /\b(software|technolog\w*|tech|saas|cloud|cyber\w*|digital|developer\w*|agency|agencies|information technology|AI)\b/i.test(s) || /\bIT\b/.test(s),
    feeds: [
      { id: 'hn', name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
      { id: 'techcrunch', name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
      { id: 'ars', name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
      { id: 'verge', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
    ],
  },
  {
    key: 'education',
    match: (s) => /\b(educat\w*|school\w*|universit\w*|college\w*|learning|student\w*|edtech|academic\w*|tutor\w*|study|abroad|admission\w*)\b/i.test(s),
    feeds: [
      { id: 'edsurge', name: 'EdSurge', url: 'https://www.edsurge.com/articles_rss' },
      { id: 'ihe', name: 'Inside Higher Ed', url: 'https://www.insidehighered.com/rss.xml' },
      { id: 'pie', name: 'The PIE News', url: 'https://thepienews.com/feed/' },
      { id: 'icef', name: 'ICEF Monitor', url: 'https://monitor.icef.com/feed/' },
    ],
  },
  {
    key: 'healthcare',
    match: (s) => /\b(health\w*|medical|clinic\w*|hospital\w*|pharma\w*|dental)\b/i.test(s),
    feeds: [
      { id: 'fierhealth', name: 'Fierce Healthcare', url: 'https://www.fiercehealthcare.com/rss/xml' },
    ],
  },
  {
    key: 'real-estate',
    match: (s) => /\b(real estate|propert\w*|realt\w*|housing|mortgage\w*|broker\w*|landlord\w*|residential|commercial real)\b/i.test(s),
    feeds: [
      { id: 'housingwire', name: 'HousingWire', url: 'https://www.housingwire.com/feed/' },
      { id: 'realtor-news', name: 'Realtor.com News', url: 'https://www.realtor.com/news/feed/' },
      { id: 'propmodo', name: 'Propmodo', url: 'https://www.propmodo.com/feed/' },
      { id: 'rismedia', name: 'RISMedia', url: 'https://www.rismedia.com/feed/' },
    ],
  },
  {
    key: 'wellness',
    match: (s) => /\b(spa\w*|salon\w*|gym\w*|fitness|wellness|beauty|barber\w*|yoga|pilates|booking|appointment\w*)\b/i.test(s),
    feeds: [
      { id: 'athletech', name: 'Athletech News', url: 'https://www.athletechnews.com/feed/' },
      { id: 'ihrsa', name: 'IHRSA', url: 'https://www.ihrsa.org/feed/' },
      { id: 'salontoday', name: 'Salon Today', url: 'https://www.salontoday.com/rss' },
    ],
  },
];

// Not in the catalog by industry: an owner who wants AI coverage on a site
// whose industry isn't tech (e.g. "AI in education") gets it through the
// tenant's main_topics, which feedsForTenant also matches against.
const MAX_FEEDS = 8;
const SECONDARY_FEEDS_PER_CATEGORY = 2;

// industries: string[] from tenantIndustries(); topics: site_profiles
// main_topics (array or JSON string) — extra words to match on, not a
// replacement for industry. override: optional per-site feed list
// ([{id?, name?, url}]) that replaces the catalog entirely (admin escape
// hatch when auto-detection is wrong — Phase 4 wires the storage).
export function feedsForTenant({ industries, topics, override } = {}) {
  if (Array.isArray(override) && override.length) {
    return override
      .filter((f) => f?.url && /^https:\/\//i.test(f.url))
      .map((f, i) => ({ id: f.id || `custom-${i}`, name: f.name || f.url, url: f.url }))
      .slice(0, MAX_FEEDS);
  }
  const topicList = Array.isArray(topics) ? topics : (typeof topics === 'string' ? safeJsonArray(topics) : []);
  const industryText = (industries || []).join(' | ');
  const topicText = topicList.map((t) => (typeof t === 'string' ? t : t?.topic || t?.name || '')).join(' | ');
  if (!industryText.trim() && !topicText.trim()) return [];

  // The site's own industry wins: an education site that also writes about AI
  // gets every education feed first, and only a couple of tech feeds for the
  // AI angle (found via main_topics). Without this, catalog order alone let
  // tech feeds crowd the education ones out of the MAX_FEEDS cap.
  const industryMatches = FEED_CATALOG.filter((e) => e.match(industryText));
  const hasSpecific = industryMatches.some((e) => !e.horizontal);
  const primary = industryMatches.filter((e) => !(e.horizontal && hasSpecific));
  const secondary = FEED_CATALOG.filter((e) => !primary.includes(e) && (industryMatches.includes(e) || e.match(topicText)));
  const picks = [
    ...primary.flatMap((e) => e.feeds.map((f) => ({ ...f, category: e.key }))),
    ...secondary.flatMap((e) => e.feeds.slice(0, SECONDARY_FEEDS_PER_CATEGORY).map((f) => ({ ...f, category: e.key }))),
  ];
  const seen = new Set();
  return picks.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true))).slice(0, MAX_FEEDS);
}

function safeJsonArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const textOf = ($el) => $el.first().text().replace(/\s+/g, ' ').trim();

function stripHtml(html) {
  return cheerio.load(`<div>${html || ''}</div>`)('div').text().replace(/\s+/g, ' ').trim();
}

// RSS 2.0 (<item>) and Atom (<entry>) both. Items without a title, a usable
// link or a parseable date are dropped, not defaulted: an undated item can't
// be called "trending now", and a linkless one can't be cited.
export function parseFeed(xml, { feedId = '', feedName = '' } = {}) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const nodes = $('item').length ? $('item') : $('entry');
  const items = [];
  nodes.each((_, el) => {
    const $el = $(el);
    const title = stripHtml(textOf($el.children('title')));
    const link = textOf($el.children('link')) || $el.children('link').first().attr('href') || textOf($el.children('guid'));
    const rawDate = textOf($el.children('pubDate')) || textOf($el.children('published')) || textOf($el.children('updated')) || textOf($el.children('dc\\:date'));
    const ts = Date.parse(rawDate);
    if (!title || !/^https?:\/\//i.test(link || '') || Number.isNaN(ts)) return;
    const summary = stripHtml(textOf($el.children('description')) || textOf($el.children('summary')) || textOf($el.children('content\\:encoded')));
    items.push({
      title,
      url: link,
      publishedAt: new Date(ts).toISOString(),
      summary: summary.slice(0, 300),
      source: feedName || feedId,
      feedId,
    });
  });
  return items;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_FEED_BYTES = 2_000_000;

// https only (a feed list is config, but an http:// or file:// entry is never
// worth the risk), bounded time and size. Throws on any failure; the caller
// decides that one dead feed must not fail the run.
export async function fetchFeed(feed, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (!/^https:\/\//i.test(feed.url)) throw new Error(`feed ${feed.id}: https required`);
  const res = await fetchImpl(feed.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeTrendRadar/1.0)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`feed ${feed.id}: HTTP ${res.status}`);
  const xml = await res.text();
  if (xml.length > MAX_FEED_BYTES) throw new Error(`feed ${feed.id}: response too large`);
  return parseFeed(xml, { feedId: feed.id, feedName: feed.name });
}

// Per-feed failures are collected, not thrown — the run reports exactly which
// sources were unreachable instead of silently trending on fewer than it says.
export async function fetchAllFeeds(feeds, opts = {}) {
  const results = await Promise.allSettled(feeds.map((f) => fetchFeed(f, opts)));
  const items = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else failed.push({ feedId: feeds[i].id, error: r.reason?.message || 'fetch failed' });
  });
  return { items, failed, fetched: feeds.length - failed.length };
}

// Newest-first, bounded age. `now` is injectable for tests.
//
// perFeedLimit keeps one high-volume feed (Hacker News posts hundreds a day)
// from filling the whole window and leaving the niche outlets — the ones that
// matter most for a non-tech tenant — with no headlines at all.
export function recentItems(items, { maxAgeDays = 7, now = Date.now(), limit = 60, perFeedLimit = 15 } = {}) {
  const cutoff = now - maxAgeDays * 86_400_000;
  const seen = new Set();
  const perFeed = new Map();
  return items
    .filter((it) => Date.parse(it.publishedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .filter((it) => (seen.has(it.url) ? false : (seen.add(it.url), true)))
    .filter((it) => {
      const n = (perFeed.get(it.feedId) || 0) + 1;
      perFeed.set(it.feedId, n);
      return n <= perFeedLimit;
    })
    .slice(0, limit);
}
