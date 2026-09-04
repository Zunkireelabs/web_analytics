// Documentation-only contract for external search-demand / keyword-trend
// providers — the extension point requested ahead of any real API key. Same
// pattern as server/providers/backlinks/provider.js: one shared shape so a
// future paid provider (DataForSEO trends, a keyword-volume API, whatever is
// eventually chosen) is a swappable adapter behind this contract — nothing
// above this layer should ever import a specific provider directly.
//
// WHY THIS EXISTS NOW, with no provider behind it yet: the fusion/scoring
// architecture (analyst-fusion.js) needs a STABLE SHAPE to reason about
// external demand today, not "add it later and rewire everything". Every
// caller asks this layer for demand and gets back either a real signal or an
// explicit `unavailable` result — never a fabricated number. See null.js,
// the only provider registered right now.
//
// Data flow this contract sits in the middle of:
//   Analyst fusion  -> asks getSearchDemandProvider() for a topic/query's
//                       demand signal, never imports a vendor SDK directly
//   Provider        -> either null.js (always unavailable, first-party-only
//                       mode) or a future real adapter implementing this
//                       same contract
//   Fusion output    -> analyst_evidence.external_demand always carries the
//                       shape below, with `available: false` when nothing is
//                       configured — so "we never had this data" and "we
//                       checked and there was none" are both a REAL record,
//                       never a silent gap.

/**
 * @typedef {Object} SearchDemandSignal
 * @property {boolean} available            false when the provider has nothing for this
 *                                           query/topic (or is not configured at all) —
 *                                           callers must render this as "unavailable",
 *                                           never substitute a guess.
 * @property {string} providerId            stable slug, e.g. "null", a future vendor id.
 * @property {number|null} searchVolume     average monthly search volume, provider units.
 * @property {'rising'|'stable'|'falling'|null} volumeTrend
 * @property {number|null} volumeTrendPct   period-over-period % change, when known.
 * @property {string[]} relatedQueries      provider-sourced related/adjacent queries.
 * @property {string[]} emergingTopics      queries/topics trending up the provider has
 *                                           flagged as new or accelerating.
 * @property {string|null} asOf             ISO date the provider's data was current as of.
 * @property {string|null} note             human-readable reason when unavailable, e.g.
 *                                           "no provider configured".
 */

/**
 * @typedef {Object} SearchDemandProvider
 * @property {string} id                                  stable slug, e.g. "null", "dataforseo-trends".
 * @property {() => boolean} configured                    whether this provider has what it needs (an
 *                                                          API key, etc.) to serve real data.
 * @property {(topic: string) => Promise<SearchDemandSignal>} fetchDemand
 * @property {(topics: string[]) => Promise<Map<string, SearchDemandSignal>>} fetchDemandBulk
 *                                                          batched form — a real provider should implement
 *                                                          this against one API call per batch rather than
 *                                                          the caller looping fetchDemand; the null provider
 *                                                          just maps fetchDemand over the input.
 */
export {};
