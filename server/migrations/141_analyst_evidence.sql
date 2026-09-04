-- The Analyst's own reasoning, stored.
--
-- Everything the Analyst currently concludes is thrown away the moment it
-- becomes a recommendation row. `recommendations` keeps one `reason` string
-- and one `confidence` number; the signals that were combined to reach that
-- conclusion, how many of them agreed, how stale their inputs were, which
-- product the topic maps to, why THIS surface was chosen over a blog, and
-- what "we will know it worked when" means are all discarded. That is why
-- the same conclusion can neither be audited after the fact nor learned
-- from: there is no record of what the system believed, only of what it did.
--
-- This table is the missing half. One row per fused conclusion, written
-- alongside the recommendation it produced (or written with
-- recommendation_id NULL when the verdict was 'monitor' — a decision NOT to
-- act is a real analyst output and disappears entirely today).
--
-- Deliberately NOT a second recommendations table. Nothing here re-implements
-- shipping, gating, drafting, capacity or PR flow — every one of those still
-- happens in the existing Action Center path off `recommendations`. This is
-- an evidence and outcome ledger that hangs off it.
CREATE TABLE IF NOT EXISTS analyst_evidence (
  id              BIGSERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,

  -- What the conclusion is ABOUT. A page URL, a query cluster key, or a
  -- topic with no page yet (the new-landing-page case, where subject_key is
  -- the topic itself because there is no URL to name).
  subject_type    TEXT NOT NULL CHECK (subject_type IN ('page', 'query-cluster', 'topic')),
  subject_key     TEXT NOT NULL,

  -- The two modes the Analyst runs in. 'decline-risk' is prevention: act
  -- before the drop lands. 'growth-opportunity' is expansion: demand exists
  -- that we are not capturing. Kept as a stored column rather than derived
  -- from the signals, because the whole point of the lane is being able to
  -- ask "how much of what we shipped was preventive?" without re-running the
  -- fusion.
  direction       TEXT NOT NULL CHECK (direction IN ('decline-risk', 'growth-opportunity')),

  -- act          — evidence clears the bar; a recommendation was created
  -- monitor      — real signal, not enough corroboration to spend a slot on
  -- insufficient — below the evidence floor entirely
  --
  -- 'monitor' rows are the reason this table exists as much as 'act' rows
  -- are: an anomaly that was seen and deliberately NOT acted on is the
  -- single most important thing to be able to show, since "we create a
  -- recommendation because an anomaly exists" is exactly the failure mode
  -- being designed out.
  verdict         TEXT NOT NULL CHECK (verdict IN ('act', 'monitor', 'insufficient')),

  -- How many INDEPENDENT signal families agreed on `direction`. Not a count
  -- of evidence items — three anomalies on the same metric are one family
  -- and must not read as three-way corroboration.
  corroboration   INTEGER NOT NULL DEFAULT 0,

  -- 0..1. Already reduced by the freshness penalty (see `freshness`), so a
  -- reader never has to remember to apply it a second time.
  confidence      NUMERIC(4, 3),

  -- The ranking number and its factor breakdown, so "why was this one picked
  -- and that one deferred" is answerable from the row.
  score           NUMERIC(8, 2),
  score_factors   JSONB,

  -- Every evidence item that went into the fusion: signal id, direction,
  -- observed values, strength, the date it was observed AT, and its source
  -- table. This is the audit trail.
  signals         JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- The input-freshness verdict at the time of the conclusion — per-signal
  -- ages and the overall state. A stale row stays visibly stale forever
  -- instead of being read later as though it had been current.
  freshness       JSONB,

  -- The nine answers (observed / changed / next / why / cause / risk /
  -- action / surface / measurement). Stored structured, not as prose, so the
  -- execution side can read `action` and `surface` as fields.
  narrative       JSONB,

  -- topic -> intent -> capability -> existing coverage -> chosen surface.
  product_mapping JSONB,

  -- Availability marker for the external search-demand provider, ALWAYS
  -- written even when unavailable. A row whose external_demand says
  -- {"available": false, ...} is permanent proof that the conclusion was
  -- reached on first-party data alone — which is what stops a later reader
  -- from assuming volume data informed it.
  external_demand JSONB,

  -- The recommendation this became. NULL for 'monitor'/'insufficient'.
  recommendation_id INTEGER REFERENCES recommendations(id) ON DELETE SET NULL,

  -- Stable across a close/re-open of the recommendation row, same role as
  -- recommendation_attempts.finding_id (139). This is the join key that
  -- carries attribution all the way to drafts.finding_id and fix_impact.
  finding_id      TEXT,

  -- Filled by the outcome sweep once fix_impact has a measured window for
  -- the draft this produced: the real before/after deltas plus which
  -- prediction they confirm or refute. NULL until then — never a zero
  -- standing in for "not measured yet".
  outcome         JSONB,
  measured_at     TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency for the nightly pass: re-running a night (or resuming after a
-- partial failure) updates the same conclusion rather than accumulating a
-- duplicate of it. finding_id is deterministic per (direction, subject).
CREATE UNIQUE INDEX IF NOT EXISTS analyst_evidence_finding_uniq
  ON analyst_evidence (site_id, finding_id);

-- The lane query: "today's actionable analyst conclusions for this site,
-- best first".
CREATE INDEX IF NOT EXISTS analyst_evidence_site_verdict_idx
  ON analyst_evidence (site_id, verdict, score DESC);

-- The outcome sweep's query: conclusions that shipped and have not been
-- measured yet.
CREATE INDEX IF NOT EXISTS analyst_evidence_pending_outcome_idx
  ON analyst_evidence (site_id, recommendation_id)
  WHERE outcome IS NULL AND recommendation_id IS NOT NULL;
