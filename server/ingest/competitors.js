import { getCompetitorProvider } from './competitor-providers/index.js';
import { getSearchPerformanceRange } from '../store/read.js';
import { resolveSiteLocations } from '../agents/lib/site-locations.js';

// Bounds weekly API spend — the site's own top real queries by impressions,
// no new keyword research, no guessing what to track.
const MAX_QUERIES = 40;

function hostnameOf(urlOrScDomain) {
  const url = urlOrScDomain.startsWith('sc-domain:') ? `https://${urlOrScDomain.slice('sc-domain:'.length)}` : urlOrScDomain;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

async function fetchWithRetry(provider, query, opts, attempts = 2) {
  for (let i = 1; i <= attempts; i++) {
    try { return await provider.fetchRankings(query, opts); }
    catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// Real competitor rankings for a site's own top real queries only, for one
// date. Returns rows shaped for store/upsert.js's saveCompetitorRankings.
// One query's failure (rate limit, no results) is logged and skipped rather
// than aborting the whole weekly batch.
export async function fetchCompetitorRankings(site, date, { start, end }) {
  const provider = getCompetitorProvider();
  const ownDomain = hostnameOf(site.gsc_property);
  // This site's own real target market (see migration 159) rather than one
  // global default for every tenant — the site's primary market when it has
  // one configured, otherwise the same global default as before.
  const { locationCode, languageCode } = resolveSiteLocations(site)[0];

  const topQueries = await getSearchPerformanceRange(site.id, start, end, 'query', MAX_QUERIES);

  const rows = [];
  for (const q of topQueries) {
    const query = q.dim_value;
    let results;
    try {
      results = await fetchWithRetry(provider, query, { locationCode, languageCode });
    } catch (err) {
      console.warn(`[competitors] "${query}" failed: ${err.message}`);
      continue;
    }
    for (const r of results) {
      rows.push({ date, query, domain: r.domain, url: r.url, position: r.position, isOwnDomain: r.domain === ownDomain });
    }
  }
  return rows;
}
