import { configured as credentialsPresent, fetchSearchVolume } from '../../ingest/dataforseo-keywords.js';

// The first real SearchDemandProvider — see ./provider.js for the contract
// and ./null.js for what everything ran on before it.
//
// Uses the Google Ads search_volume endpoint, NOT Labs keyword_ideas, and
// that is the deliberate choice: this provider is asked "how much demand
// does THIS topic have", an exact-match question. keyword_ideas is an
// expansion product — it costs more, returns a hundred adjacent terms
// nobody asked for, and (confirmed live) rejects some locations
// search_volume accepts. Expansion already has its own caller in
// agents/lib/keyword-demand.js.
//
// TWO GATES, both required. Credentials alone must not activate this:
// every call is billed, and this provider is reachable from the topic
// scorer, which runs on cron for every tenant. So SEARCH_DEMAND_PROVIDER
// has to name it explicitly. A deploy that merely has DataForSEO keys for
// the SERP and backlinks adapters does not silently start paying for this.
export const PROVIDER_ID = 'dataforseo';

// DataForSEO's own system. Defaulted, not guessed per tenant: 2840/en is
// the United States, the broadest market, and a topic's demand there is a
// usable relative signal for ranking topics against each other even when
// the tenant sells elsewhere. A per-tenant market belongs in the caller,
// which knows the tenant; this provider's contract takes only a topic.
const DEFAULT_LOCATION_CODE = Number(process.env.SEARCH_DEMAND_LOCATION_CODE || 2840);
const DEFAULT_LANGUAGE_CODE = process.env.SEARCH_DEMAND_LANGUAGE_CODE || 'en';

// DataForSEO accepts up to 1000 keywords per search_volume request; the
// adapter already caps at 20 per call, so batches are chunked to match.
const MAX_PER_REQUEST = 20;

// Monthly search volume is a 12-month average that genuinely does not move
// week to week, and every lookup is billed. A long in-process TTL is the
// cheapest correct thing: the scorer runs on cron and re-asks about the
// same evergreen topics every cycle.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map();

export function clearDemandCache() {
  cache.clear();
}

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}

const normalize = (topic) => String(topic || '').trim().toLowerCase();

function unavailable(note) {
  return {
    available: false,
    providerId: PROVIDER_ID,
    searchVolume: null,
    volumeTrend: null,
    volumeTrendPct: null,
    relatedQueries: [],
    emergingTopics: [],
    asOf: null,
    note,
  };
}

// Direction from the real 12-month series, never from the average alone.
// Compares the most recent quarter against the one before it: a single
// month is too noisy to call a trend, and a year-over-year comparison
// cannot see a change that started three months ago.
//
// Returns nulls rather than 'stable' when there is not enough series to
// judge. 'stable' is a claim, and claiming it from two data points is the
// kind of confident-wrong number this whole provider layer exists to avoid.
export function trendFromMonthly(monthlySearches) {
  const series = Array.isArray(monthlySearches) ? monthlySearches : [];
  if (series.length < 6) return { volumeTrend: null, volumeTrendPct: null };

  const sum = (rows) => rows.reduce((n, r) => n + Number(r.searchVolume || 0), 0);
  const recent = sum(series.slice(0, 3));
  const prior = sum(series.slice(3, 6));
  if (prior <= 0) return { volumeTrend: null, volumeTrendPct: null };

  const pct = ((recent - prior) / prior) * 100;
  // 15% is the band inside which seasonality alone explains the move. Below
  // it the honest answer is 'stable', not a direction.
  const volumeTrend = pct >= 15 ? 'rising' : pct <= -15 ? 'falling' : 'stable';
  return { volumeTrend, volumeTrendPct: Math.round(pct * 10) / 10 };
}

function signalFromRow(row) {
  const { volumeTrend, volumeTrendPct } = trendFromMonthly(row.monthlySearches);
  const newest = row.monthlySearches?.[0];
  return {
    available: true,
    providerId: PROVIDER_ID,
    searchVolume: row.searchVolume,
    volumeTrend,
    volumeTrendPct,
    // This endpoint returns volume for the exact keywords asked about and
    // expands nothing, so both of these are genuinely empty rather than
    // unfetched. Filling them would mean paying for the Labs expansion
    // product on a call whose question was "how much demand does this have".
    relatedQueries: [],
    emergingTopics: [],
    asOf: newest ? `${newest.year}-${String(newest.month).padStart(2, '0')}-01` : null,
    note: null,
  };
}

export const dataForSeoSearchDemandProvider = {
  id: PROVIDER_ID,

  configured() {
    return process.env.SEARCH_DEMAND_PROVIDER === PROVIDER_ID && credentialsPresent();
  },

  async fetchDemand(topic) {
    const map = await this.fetchDemandBulk([topic]);
    return map.get(topic) || unavailable('No demand data returned for this topic.');
  },

  // One request per chunk of 20, not one per topic: the contract exists
  // precisely so a real provider batches.
  async fetchDemandBulk(topics) {
    const out = new Map();
    const list = (topics || []).filter((t) => normalize(t));
    if (!list.length) return out;

    const pending = [];
    for (const topic of list) {
      const hit = cached(normalize(topic));
      if (hit) out.set(topic, hit);
      else pending.push(topic);
    }
    if (!pending.length) return out;

    for (let i = 0; i < pending.length; i += MAX_PER_REQUEST) {
      const chunk = pending.slice(i, i + MAX_PER_REQUEST);
      let rows;
      try {
        rows = await fetchSearchVolume(chunk, {
          locationCode: DEFAULT_LOCATION_CODE,
          languageCode: DEFAULT_LANGUAGE_CODE,
        });
      } catch (err) {
        // An outage, a quota refusal or an unsupported location is reported
        // as unavailable-with-a-reason, exactly as the null provider does.
        // The one thing this must never do is let a caller treat a failed
        // lookup as zero demand, which would silently deprioritise every
        // topic in the batch.
        const note = `DataForSEO search-demand lookup failed: ${err.message}`;
        for (const topic of chunk) out.set(topic, unavailable(note));
        continue;
      }

      const byKeyword = new Map(rows.map((r) => [normalize(r.keyword), r]));
      for (const topic of chunk) {
        const row = byKeyword.get(normalize(topic));
        // A keyword the endpoint returned nothing for is a REAL answer:
        // DataForSEO omits keywords with no measurable volume. 'available:
        // false' with this note is the honest record — not a zero, which a
        // caller could not distinguish from "we never asked".
        const signal = row
          ? signalFromRow(row)
          : unavailable('DataForSEO reports no measurable search volume for this topic.');
        // Cached either way, so a no-volume topic is not re-billed every run.
        cache.set(normalize(topic), { at: Date.now(), value: signal });
        out.set(topic, signal);
      }
    }
    return out;
  },
};
