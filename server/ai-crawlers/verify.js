import { makeMatcher, isNonPublicIp, parseCidr } from './ip-match.js';
import { describeFetchFailure, describeHttpFailure } from '../lib/errors.js';

// Is a visit really from the vendor it says it is? Anyone can send "GPTBot" as their user agent, so a visit is only counted as
// verified when the address is inside the vendor's own published list. Three honest outcomes:
//
//   verified    user agent matches AND the address is inside the vendor's list
//   unverified  user agent matches but the address is NOT in the list (or is missing / private): possibly a fake
//   unchecked   we could not check: the vendor publishes no list, or the list could not be loaded right now.
//               A real crawler must never be called fake because OUR fetch of a list failed.
//
// The lists are fetched, not hard-coded: vendors change them (OpenAI's ChatGPT-User list was updated 2026-11-06).

// Each URL was fetched and its format checked on 2026-11-18. Same shape everywhere:
//   { "creationTime": "...", "prefixes": [ { "ipv4Prefix": "a.b.c.d/nn" } | { "ipv6Prefix": "..." } ] }
export const LIST_URLS = Object.freeze({
  'openai-gptbot': 'https://openai.com/gptbot.json',
  'openai-searchbot': 'https://openai.com/searchbot.json',
  'openai-chatgpt-user': 'https://openai.com/chatgpt-user.json',
  // Anthropic publishes ONE combined list for ClaudeBot, Claude-User and Claude-SearchBot, not one per bot.
  anthropic: 'https://claude.com/crawling/bots.json',
  'perplexity-bot': 'https://www.perplexity.ai/perplexitybot.json',
  'perplexity-user': 'https://www.perplexity.ai/perplexity-user.json',
  apple: 'https://search.developer.apple.com/applebot.json',
  'google-common': 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json',
  'google-user-triggered-agents': 'https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json',
});

const FETCH_TIMEOUT_MS = 15000;
const MAX_LIST_BYTES = 2_000_000; // the biggest real list is ~75 KB; refuse anything absurd

/** Text of a vendor list -> { ok: true, cidrs, creationTime } or { ok: false, error }. An empty list is a failure, not "nothing is verified". */
export function parseRangesJson(text) {
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, error: 'not valid JSON' }; }
  if (!json || !Array.isArray(json.prefixes)) return { ok: false, error: 'no prefixes array' };
  const cidrs = [];
  for (const p of json.prefixes) {
    const c = p?.ipv4Prefix || p?.ipv6Prefix;
    if (typeof c === 'string' && parseCidr(c)) cidrs.push(c.trim());
  }
  if (!cidrs.length) return { ok: false, error: 'no usable prefixes' };
  return { ok: true, cidrs, creationTime: typeof json.creationTime === 'string' ? json.creationTime : null };
}

/**
 * Fetch every list. Returns a plain, JSON-safe object { [listId]: { ok, cidrs?, creationTime?, error? } } so it can be cached
 * in the database as it is. One list failing never affects the others. `fetchImpl` is injectable for tests.
 */
export async function loadRangeLists({ fetchImpl = fetch, urls = LIST_URLS } = {}) {
  const out = {};
  await Promise.all(Object.entries(urls).map(async ([id, url]) => {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: 'application/json' } });
      if (!res.ok) { out[id] = { ok: false, error: describeHttpFailure(res.status) }; return; }
      const text = await res.text();
      out[id] = text.length > MAX_LIST_BYTES ? { ok: false, error: 'list too large' } : parseRangesJson(text);
    } catch (err) {
      out[id] = { ok: false, error: describeFetchFailure('ai-crawlers.verify.loadRangeLists', err) };
    }
  }));
  return out;
}

/** Plain lists (from loadRangeLists or the cache table) -> a checker with compiled matchers. */
export function compileRanges(lists) {
  const matchers = new Map();
  for (const [id, l] of Object.entries(lists || {})) if (l?.ok && l.cidrs?.length) matchers.set(id, makeMatcher(l.cidrs));
  return {
    has: (id) => matchers.has(id),
    contains: (id, ip) => (matchers.get(id)?.(ip)) === true,
  };
}

/** 'verified' | 'unverified' | 'unchecked' for one visit by a recognised bot. */
export function verifyVisit(bot, clientIp, ranges) {
  if (!bot.list) return 'unchecked';
  if (!ranges?.has(bot.list)) return 'unchecked';
  if (!clientIp || isNonPublicIp(clientIp)) return 'unverified';
  return ranges.contains(bot.list, clientIp) ? 'verified' : 'unverified';
}
