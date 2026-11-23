import { fetchSerps } from '../../lib/serp.js';
import { clusterBySerp, overlapScore } from '../../lib/serp-overlap.js';

// Before a ship day queues its keywords, finds the ones Google treats as the SAME search: their top-10 results share 7 or more pages
// (lib/serp-overlap.js). Writing a post for each would put two near-identical pages up against each other for one search (the pages
// cannibalize each other), so only one is queued and the rest are folded into it.
//
// Rules, each one a way this must not surprise a person:
//  - A keyword a person typed in (or a trend-radar topic) is NEVER folded away. If it shares a page with others, the others fold into it.
//  - Two person-chosen keywords are never folded into each other.
//  - Only keywords that were actually looked up are judged. A keyword with no results (not configured, budget refused, no data) is
//    queued exactly as before: no result is never a reason to drop a keyword.
//  - At most MAX_KEYWORDS are looked up per ship day (one cached, budgeted lookup each); the rest are queued as before.
//  - A folded keyword is only DISMISSED with a note saying where it went. A person can put it back.
// Nothing here writes: it returns the plan, and the schedule applies it.

export const MAX_KEYWORDS = 20;
export const serpMergeEnabled = (env = process.env) => !/^(0|false|off|no)$/i.test(String(env.KEYWORD_SERP_MERGE || '').trim());
export const serpMergeLimit = (env = process.env) => Math.min(50, Math.max(2, Number.parseInt(env.KEYWORD_SERP_MAX, 10) || MAX_KEYWORDS));

const volumeOf = (g) => Number(g.search_volume) || 0;

/**
 * @param keywords  keyword_gaps rows about to be queued ({ id, topic, search_volume, search_intent, source })
 * @param chosenSources  sources that mean "a person asked for this"
 * @returns { merges: [{ keywordId, topic, intoId, intoTopic, shared, note }], looked: number, liveCalls: number, stoppedEarly }
 */
export async function planSerpMerges({ siteId, site, keywords, chosenSources = new Set(), lookup = fetchSerps, maxKeywords = serpMergeLimit() }) {
  const empty = { merges: [], looked: 0, liveCalls: 0, stoppedEarly: null };
  const list = (keywords || []).filter((g) => g?.topic).slice(0, maxKeywords);
  if (list.length < 2) return empty;

  const { byKeyword, liveCalls, stoppedEarly } = await lookup(siteId, list.map((g) => g.topic), { site });
  // Keyword text is the key; two gaps with the same text are one search, so the first is kept as the representative.
  const byTopic = new Map();
  const items = [];
  for (const g of list) {
    const res = byKeyword.get(g.topic);
    if (!res?.ok || byTopic.has(g.topic)) continue;
    byTopic.set(g.topic, g);
    // matchKey, not url: SerpApi's redirect links carry no stable address (see lib/serp.js parseSerpApi), so the same page is matched by domain + title
    items.push({ keyword: g.topic, urls: res.results.map((r) => r.matchKey || r.url), volume: volumeOf(g), intent: g.search_intent || undefined });
  }
  if (items.length < 2) return { ...empty, looked: items.length, liveCalls, stoppedEarly };

  const { pages } = clusterBySerp(items);
  const merges = [];
  for (const page of pages) {
    if (page.keywords.length < 2) continue;
    const members = page.keywords.map((k) => byTopic.get(k));
    // The one that stays: a person's keyword first, then the biggest, then the oldest.
    const keep = [...members].sort((a, b) => (chosenSources.has(b.source) - chosenSources.has(a.source)) || volumeOf(b) - volumeOf(a) || a.id - b.id)[0];
    const keepUrls = items.find((i) => i.keyword === keep.topic).urls;
    for (const g of members) {
      if (g === keep || chosenSources.has(g.source)) continue;
      const shared = overlapScore(items.find((i) => i.keyword === g.topic).urls, keepUrls);
      merges.push({
        keywordId: g.id, topic: g.topic, intoId: keep.id, intoTopic: keep.topic, shared,
        note: `Merged into "${keep.topic}": Google shows almost the same results for both (${shared} of 10 pages are the same), so one page serves both. Set it back to pending if you want a separate page.`,
      });
    }
  }
  merges.sort((a, b) => a.keywordId - b.keywordId);
  return { merges, looked: items.length, liveCalls, stoppedEarly };
}
