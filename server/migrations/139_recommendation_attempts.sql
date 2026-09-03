-- One durable row per ATTEMPT to resolve a recommendation, so "how many
-- times have we tried this, and why did it fail last time" is a fact the
-- system stores rather than a string it re-derives.
--
-- Today that history exists only as free text in drafts.abandoned_reason,
-- reconstructed by countFailedAttemptsByFinding (store/drafts.js) with a
-- hand-curated list of NOT LIKE exclusions. That list encodes real, correct
-- knowledge — a rate limit is transient, a missing url_file_map entry is a
-- config gap a human closes, an anchor that no longer matches is a genuine
-- defect in the item — but it encodes it in SQL string matching against
-- sentences written for humans elsewhere in the codebase. It has already
-- broken twice for that reason: an apostrophe in DESIGN_NOT_REVIEWED_FRAGMENT
-- silently failed the whole query (2026-09-03), and two analytics findings sat
-- retired at 15 and 12 "attempts" whose cause a human had already fixed
-- (2026-09-01).
--
-- This table records the classification AT THE MOMENT OF THE ATTEMPT, from
-- the structured error the attempt actually raised, so no later reader has to
-- parse prose to recover it. failure_class reuses the closed set already
-- defined in lib/failure-classification.js rather than inventing a parallel
-- taxonomy; retry_policy is the decision that class implies for THIS pipeline.
--
-- Deliberately additive: countFailedAttemptsByFinding keeps working exactly as
-- it does today off drafts.abandoned_reason. This table drives the
-- recommendation's lifecycle state, its displayed attempt history, and the
-- reconciler's retry decisions. Consolidating the convergence cap onto it is a
-- follow-up, once there is enough history here to compare the two.
CREATE TABLE IF NOT EXISTS recommendation_attempts (
  id                SERIAL PRIMARY KEY,
  site_id           INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  -- Nullable, and ON DELETE SET NULL rather than CASCADE: an attempt is
  -- evidence about work that was done, and it stays true after the
  -- recommendation row it was made against is closed and swept away. Same
  -- reasoning migration 105 applied to execution_job_recommendations.draft_id,
  -- for the same reason — a FK that cascades turns history into a liability
  -- that blocks deletes elsewhere.
  recommendation_id INTEGER REFERENCES recommendations(id) ON DELETE SET NULL,
  -- The stable identity across recommendation rows. A recommendation can be
  -- closed and re-opened as a new row for the same underlying issue; the
  -- finding_id survives that, which is what makes attempt history additive
  -- across a re-open instead of resetting to zero every time.
  finding_id        TEXT,
  draft_id          INTEGER REFERENCES drafts(id) ON DELETE SET NULL,
  -- shipped   — reached a merged PR (or an implemented no-PR action type)
  -- failed    — the attempt ended in an error; failure_class says what kind
  -- returned  — reclaimed by the reconciler and put back on the board
  -- superseded— the issue was resolved or replaced before this attempt landed
  outcome           TEXT NOT NULL CHECK (outcome IN ('shipped', 'failed', 'returned', 'superseded')),
  -- One of lib/failure-classification.js's FAILURE_CLASS values. NULL for a
  -- 'shipped' outcome, which has no failure to classify.
  failure_class     TEXT,
  -- What this pipeline should DO about it. Distinct from failure_class on
  -- purpose: two different classes can imply the same action, and the action
  -- is what the reconciler and the UI branch on.
  retry_policy      TEXT CHECK (retry_policy IN ('retry', 'needs_human', 'already_resolved', 'item_defect', 'never')),
  -- The customer-safe reason string, already sanitized by the caller (every
  -- writer passes text that has been through lib/errors.js's safeMessage or
  -- is an author-written constant). Never a raw provider error body.
  reason            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The read the reconciler and the lifecycle derivation both do: "every
-- attempt for this site's findings, newest first".
CREATE INDEX IF NOT EXISTS recommendation_attempts_site_finding_idx
  ON recommendation_attempts (site_id, finding_id, created_at DESC);

-- The read the Action Center card does: this recommendation's own history.
CREATE INDEX IF NOT EXISTS recommendation_attempts_rec_idx
  ON recommendation_attempts (recommendation_id, created_at DESC);
