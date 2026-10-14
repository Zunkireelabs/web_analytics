-- Scoped Decision Engine integration (feature-flagged, see migration 174) —
-- the one case the architecture audit judged worth decision-engine.js's
-- reasoning: a finding that fell all the way through recommendation-
-- taxonomy.js's classify() to its DEFAULT catch-all. See
-- server/agents/lib/default-bucket-decision.js for how this gets set.
--
-- Nullable and NOT recomputed unconditionally on every sync, unlike goal_id
-- (171/172): a decide() call is bounded/rare by design
-- (MAX_DECISION_ENGINE_CALLS_PER_RUN caps how many DEFAULT-bucket findings
-- actually get one per run), so a finding whose decision simply didn't make
-- this run's cap must keep whatever decision_id a prior run already
-- recorded, not have it wiped back to NULL — see
-- store/recommendations.js's mergeIntoRecommendation, which COALESCEs this
-- column rather than overwriting it unconditionally the way goal_id does.
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS decision_id INTEGER REFERENCES decisions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS recommendations_decision_idx ON recommendations (decision_id) WHERE decision_id IS NOT NULL;
