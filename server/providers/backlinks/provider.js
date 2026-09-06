// Documentation-only contract for backlink/referring-domain data providers —
// a shared interface so Common Crawl (free, host-level webgraph), DataForSEO
// (existing paid backlinks API, untouched by this file), and any future
// provider are swappable adapters behind one contract — nothing above this
// layer should ever import a specific provider directly. Same pattern as
// server/ingest/competitor-providers/types.js.
//
// Data flow this contract sits in the middle of:
//   ETL imports  -> populate the database (e.g. commoncrawl_backlink_domains,
//                    commoncrawl_backlink_summary — migrations 044/045)
//   Providers    -> read the database (or call a live API) and implement
//                    this contract, normalizing to the same shape
//   Agents       -> consume providers, never the database or a vendor API
//                    directly
//   Dashboard    -> consumes agents/API output only
//
// server/providers/backlinks/commoncrawl.js (Phase 3) is the first provider
// to implement this contract, reading only from the database populated by
// server/scripts/refresh-commoncrawl-graph.js — never a network request. See
// server/ingest/dataforseo-backlinks.js for the existing, separate DataForSEO
// integration this contract does not replace or modify.

/**
 * @typedef {Object} ReferringDomain
 * @property {string} sourceDomain    bare domain linking to the target, e.g. "example.com"
 * @property {string} graphRelease    the data release/version this edge was observed in
 */

/**
 * @typedef {Object} DomainBacklinkSummary
 * @property {string} domain            bare domain, e.g. "example.com"
 * @property {number|null} referringDomains
 * @property {number|null} graphRank    provider-defined rank/authority signal, lower/higher meaning is provider-specific
 * @property {string} graphRelease      the data release/version this summary was computed from
 * @property {string} updatedAt         ISO timestamp this summary was last (re)computed
 */

/**
 * @typedef {Object} BacklinkProvider
 * @property {string} id                   stable slug, e.g. "commoncrawl", "dataforseo"
 * @property {() => boolean} configured    whether this provider has what it needs to serve data
 * @property {(domain: string) => Promise<ReferringDomain[]>} fetchReferringDomains
 * @property {(domain: string) => Promise<DomainBacklinkSummary|null>} fetchDomainSummary
 */
export {};
