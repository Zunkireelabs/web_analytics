// Documentation-only contract for competitor/SERP data providers — no
// runtime code. Explicitly built so DataForSEO (the first, chosen provider)
// is a swappable adapter, not something the ingestion/agent/orchestrator
// layers are coupled to. Adding a second provider (SerpApi, Ahrefs, ...)
// means adding one file here and registering it in index.js — nothing in
// ingest/competitors.js, agents/competitor-intelligence.js, or the
// orchestrator should ever import a specific provider directly.

/**
 * @typedef {Object} SerpResult
 * @property {string} domain          bare domain, e.g. "example.com" (no protocol/path)
 * @property {string} url             the full ranking URL
 * @property {number} position        1-based organic rank for this query
 */

/**
 * @typedef {Object} CompetitorProvider
 * @property {string} id              stable slug, e.g. "dataforseo"
 * @property {(query: string, opts: { locationCode: number, languageCode: string }) =>
 *              Promise<SerpResult[]>} fetchRankings
 *              Real organic SERP results for one query, position-ordered.
 *              Must throw on a hard failure (bad credentials, provider
 *              outage) — callers decide how to degrade, a provider must
 *              never silently return an empty/fabricated result set.
 */
export {};
