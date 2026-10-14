// Shared interpretation of Google's real per-page index inspection
// (server/ingest/gsc-technical.js's inspectUrl, persisted as
// technical_seo_checks.index_status) — used by sitemap-conflict.js (to
// detect a sitemap-listed URL Google reports as blocked) and sitemap.js
// (to make sure it never re-adds a URL sitemap-removal just removed
// specifically because Google confirmed it's blocked — see that file's
// own comment on why this loop-prevention check exists).

const BLOCKING_ROBOTS_STATES = new Set(['DISALLOWED']);
const BLOCKING_INDEXING_STATES = new Set(['BLOCKED_BY_META_TAG', 'BLOCKED_BY_HTTP_HEADER', 'BLOCKED_BY_ROBOTS_TXT']);

export function isConfirmedBlocked(indexStatus) {
  if (!indexStatus) return false;
  return BLOCKING_ROBOTS_STATES.has(indexStatus.robotsTxtState) || BLOCKING_INDEXING_STATES.has(indexStatus.indexingState);
}

export { BLOCKING_ROBOTS_STATES, BLOCKING_INDEXING_STATES };
