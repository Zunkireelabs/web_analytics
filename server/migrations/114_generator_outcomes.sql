-- Phase 5 learning loop: a plain structured log of what happened when a
-- generator's work was acted on — nothing more. No model, no training loop,
-- no separate confidence table to keep in sync — generator-learning.js
-- computes a score on read, from these rows, over a bounded trailing window.
-- That is the whole "simple evidence/score-based learning" the spec asks
-- for: reuse the existing recommendation/draft lifecycle as the evidence
-- source, log it, and aggregate it when a decision needs it.

CREATE TABLE IF NOT EXISTS generator_outcomes (
  id             SERIAL PRIMARY KEY,
  site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  generator_id   TEXT NOT NULL,

  -- 'shipped'   — auto-remediation produced a validated draft and opened a PR
  -- 'failed'    — a genuine fault (not a principled refusal) during drafting
  -- 'refused'   — the generator honestly declined; NOT a failure signal (see
  --               auto-remediation.js's own refusal/failure distinction —
  --               kept as its own value here for the same reason: a refusal
  --               says nothing about whether the generator is trustworthy)
  -- 'merged'    — the strongest positive signal: a human actually merged it
  -- 'rejected'  — a human reviewed and declined it in Action Center
  outcome        TEXT NOT NULL CHECK (outcome IN ('shipped','failed','refused','merged','rejected')),

  recommendation_id INTEGER,
  draft_id       INTEGER,

  -- Free text is NEVER an error message or provider response — see
  -- lib/errors.js's UserFacingError discipline, which every caller of
  -- recordOutcome must already have applied before this text exists.
  detail         TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only query pattern this table serves: "recent outcomes for this site's
-- this generator", so the learned-confidence read stays a single indexed
-- range scan even as the table grows.
CREATE INDEX IF NOT EXISTS generator_outcomes_site_generator
  ON generator_outcomes (site_id, generator_id, created_at DESC);
