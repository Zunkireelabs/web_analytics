// Single source of truth for three error-message FRAGMENTS that get matched
// back out of free-text `abandoned_reason`/error strings by TWO consumers —
// auto-remediation.js's isRefusal pattern-matching, and store/drafts.js's
// convergence-cap exclusion list.
//
// That matching is inherently fragile (this codebase's own rate-limit work
// says so directly: "matching prose is how a classifier quietly stops
// recognising the thing it was written for" — lib/failure-classification.js).
// A typed error code would be the real fix, but the shape here
// ({ ok: false, reason, error }) already carries a `reason` code that never
// survives past approveAndPublishDraft — action-center.js persists only the
// `error` string to drafts.abandoned_reason, and that string is all either
// consumer below has to work with. Widening the persisted shape to keep
// `reason` is a larger change than this fix warrants; this file at least
// gives the two consumers ONE literal to import instead of two independently
// hand-typed copies that can silently drift apart.
//
// The producing side is NOT centralized here — each of these phrases is
// already duplicated verbatim across multiple implementer files (confirmed:
// NO_FILE_MAPPING_FRAGMENT alone appears literally in alt-text-inject.js,
// content-integrity-inject.js, and schema-repair-inject.js), so unifying
// production too is its own, larger refactor. If either fragment ever needs
// to change, grep for the fragment string across server/implementers/ AND
// update every match — this file's constants must be updated to match.
export const NO_FILE_MAPPING_FRAGMENT = 'No url_file_map entry matches';
export const NO_MARKERS_CONFIGURED_FRAGMENT = 'No markers configured for';
export const UNVERIFIED_PLACEHOLDER_FRAGMENT = 'unverified placeholder field';
