import { query } from '../db.js';

// Reads and writes the results-page cache (migration 265). See lib/serp.js.

/** The cached results for a keyword in a market, only if they are younger than maxAgeDays; otherwise null. */
export async function readSerpCache(keywordKey, locationCode, languageCode, maxAgeDays) {
  const { rows } = await query(
    `SELECT results, people_also_ask, related_searches, features, fetched_at
       FROM serp_cache
      WHERE keyword_key = $1 AND location_code = $2 AND language_code = $3 AND fetched_at > now() - make_interval(days => $4)`,
    [keywordKey, locationCode, languageCode, maxAgeDays],
  );
  const r = rows[0];
  return r ? { results: r.results, peopleAlsoAsk: r.people_also_ask, relatedSearches: r.related_searches, features: r.features, fetchedAt: r.fetched_at } : null;
}

export async function writeSerpCache(keywordKey, locationCode, languageCode, serp) {
  await query(
    `INSERT INTO serp_cache (keyword_key, location_code, language_code, results, people_also_ask, related_searches, features, fetched_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, now())
     ON CONFLICT (keyword_key, location_code, language_code)
     DO UPDATE SET results = EXCLUDED.results, people_also_ask = EXCLUDED.people_also_ask, related_searches = EXCLUDED.related_searches,
                   features = EXCLUDED.features, fetched_at = now()`,
    [keywordKey, locationCode, languageCode, JSON.stringify(serp.results), JSON.stringify(serp.peopleAlsoAsk), JSON.stringify(serp.relatedSearches), JSON.stringify(serp.features)],
  );
}
