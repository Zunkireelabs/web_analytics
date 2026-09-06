-- Adds the terminal state that was missing: a recommendation whose target
-- page has been PROVEN not to exist (a soft-404, a mapped file that's gone,
-- adapter data that will never be ready) was previously left open forever.
--
-- buildRecommendations already discovers this — recommendation-gates.js's
-- `drop` outcomes (soft-404, file-missing, adapter-data-not-ready) — but a
-- dropped finding was simply excluded from detectedKeys, and
-- closeStaleRecommendations only closes a row when its detecting agent
-- genuinely re-checked that exact page this run (the rotation-batch guard,
-- there to distinguish "not re-checked today" from "fixed"). A page that no
-- longer exists is never in a rotation batch again, so a row dropped by a
-- hard gate was immortal — the exact mechanism that kept 6 /docs/* rows open
-- on site 1 indefinitely.
--
-- 'unfixable' is DIRECT evidence from this run (we looked at this exact page
-- and proved it cannot be fixed), not an absence-of-evidence closure, so it
-- deliberately bypasses the rotation guard — see
-- store/recommendations.js's markRecommendationsUnfixable.
ALTER TABLE recommendations DROP CONSTRAINT IF EXISTS recommendations_status_check;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_status_check
  CHECK (status IN ('open', 'unfixable', 'dismissed', 'superseded'));

-- Excluded from the status='open' partial dedup index automatically (any
-- status other than 'open' frees the key), so if a page with the same
-- (site, page, recommendation_type) genuinely reappears later, a fresh row
-- opens rather than being blocked by this closed one — no index change
-- needed, the existing WHERE status = 'open' already does the right thing.

-- WHY a recommendation is blocked, distinct from the human-readable
-- blocked_reason text — the Action Center needs to render different copy for
-- "we haven't finished configuring your repo" (our-config: actionable by the
-- tenant), "the Design Agent is still learning your site" (awaiting-
-- derivation: nothing to do, will clear on its own) and "this page is shared
-- with others" (site-fact: a real architectural constraint, not a gap). Never
-- shown as raw text — see store/recommendations.js's classifyBlockedKind for
-- the mapping from blocked_reason's text to this classification.
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS blocked_kind TEXT
  CHECK (blocked_kind IS NULL OR blocked_kind IN ('our-config', 'awaiting-derivation', 'site-fact'));

-- When the CURRENT block started, so the UI can eventually say "blocked for
-- 3 days" rather than just "blocked" — set on the transition from unblocked
-- to blocked, left untouched while it stays blocked, cleared when it clears.
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS blocked_since TIMESTAMPTZ;
