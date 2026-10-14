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

// broken-link-fix's own mapping gap (implementers/backend.js). It reads as a
// per-item failure but is the same class of problem as
// NO_FILE_MAPPING_FRAGMENT: the href genuinely exists on the live page, and
// the file carrying it — very often a shared header/footer, not the page's
// own mapped file — simply isn't reachable from url_file_map or the bounded
// local search. Nothing about the item changes between attempts.
export const LINK_TARGET_UNRESOLVABLE_FRAGMENT = 'No file could be found or safely stripped for href';

// A strictly narrower case of the fragment above, added once the repo-local
// search fallback started reading the whole repo as one tarball
// (server/implementers/lib/repo-local-search.js, 2026-09-08) instead of a
// bounded sample: when that full-coverage search ALSO finds zero candidate
// files containing the href, "add a url_file_map entry" (the summary
// LINK_TARGET_UNRESOLVABLE_FRAGMENT gives a human) can no longer be the
// right advice — a mapping cannot surface a string that provably isn't
// hardcoded anywhere in the repo. Must be matched BEFORE the fragment above
// wherever both are checked, since this is always a substring of a message
// that also contains it.
export const LINK_CONFIRMED_ABSENT_FRAGMENT = 'confirmed absent from every real candidate file in the repo';

// The human design-review sign-off gate this fragment came from was removed
// entirely by commit 8a32037 ("Remove the human design-review gate; automate
// it at ship time instead") — no code path produces this string any more.
// Kept only as a convergence-cap exclusion (store/drafts.js): the abandoned
// drafts it already produced before removal are still inside the 30-day
// window and, left uncounted-for, permanently suppress auto-retry on
// findings whose only real failure was a gate that no longer exists —
// confirmed live on site 1, where 7 currently-capped findings owe their
// entire failure count to this one dead reason.
export const DESIGN_NOT_REVIEWED_FRAGMENT = "This site's design has not been reviewed yet";

// redirect-chain-nginx-inject.js's own mapping gap: the redirect this
// finding is about is real (observed live), but no nginx `location =` or
// `rewrite` rule for it exists in any file this platform can see — it's
// defined elsewhere (a CDN, a CMS, DNS). Nothing about retrying changes
// that; without this rule the failure fell through to the ITEM_DEFECT
// default, and the recovery-cycle logic (which exists to re-check
// genuinely stale evidence) kept resetting the attempt count on a cause
// that can never resolve itself — confirmed live on site 1 (2026-09-18):
// two redirect-chain findings stuck at 8 attempts each, still open, never
// blocked.
export const REDIRECT_RULE_NOT_FOUND_FRAGMENT = 'the redirect may be defined elsewhere (a CDN, a CMS, DNS)';

// section-preservation-gate.js's CLAUDE.md §2 refusal: the draft would
// delete a section that's live on the site today. This is a deliberate,
// permanent safety refusal, not a bug in the draft — it will refuse
// identically every time until a human either accepts the removal by hand
// or dismisses the finding. Same ITEM_DEFECT-fallthrough problem as the
// redirect fragment above: four findings on site 1 were retrying against
// this gate indefinitely.
export const SECTION_REMOVAL_REFUSED_FRAGMENT = 'never take away a section the client already has (CLAUDE.md §2)';
