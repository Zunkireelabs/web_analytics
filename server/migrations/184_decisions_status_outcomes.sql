-- Close the Decision Engine's loop.
-- (server/agents/lib/decision-lifecycle.js, server/store/decisions.js)
--
-- decisions (166) was built with a full lifecycle — decided → executing →
-- shipped → verified → failed — and an outcome_ref column documented as
-- "links forward to agent_fix_memory / fix-impact once shipped". Neither was
-- ever used: setDecisionOutcome had exactly one caller, every row sits at
-- 'decided' forever, and outcome_ref is NULL everywhere.
--
-- The consequence is not cosmetic. An engine that records what it decided
-- but never what happened cannot tell a decision that shipped and worked
-- from one that shipped and made things worse, so it cannot learn from
-- either. Everything needed is already measured — fix_impact (104) computes
-- real before/after windows, generator_outcomes records every attempt — it
-- simply was never connected back.
--
-- This migration only adds what reading that lifecycle requires. The status
-- values and the outcome_ref column already exist and are unchanged, so no
-- row is rewritten and no constraint is loosened.

-- The read the lifecycle actually performs: this site's decisions by state.
-- 166's own status index is partial (WHERE status != 'verified') and carries
-- no site_id, so a per-tenant query by state cannot use it.
CREATE INDEX IF NOT EXISTS decisions_site_status_idx
  ON decisions (site_id, status);

-- The sweep's read: oldest unfinished decisions first, across all sites.
-- Partial, because a verified decision is terminal and is never swept again.
CREATE INDEX IF NOT EXISTS decisions_open_idx
  ON decisions (status, created_at)
  WHERE status IN ('decided', 'executing', 'shipped');

-- Finding the decision behind a shipped recommendation is the lifecycle's
-- hot path, and 173's index covers only recommendations.decision_id in one
-- direction. This is the reverse lookup.
CREATE INDEX IF NOT EXISTS recommendations_decision_status_idx
  ON recommendations (decision_id, status)
  WHERE decision_id IS NOT NULL;

-- The :40 impact sweep works from a fix_impact row, which carries a
-- draft_id and a finding_id but no recommendation_id — so closing the loop
-- from a MEASUREMENT back to the decision that caused it means looking a
-- recommendation up by one of its finding ids. finding_ids is a TEXT[] with
-- no index at all today, which is also why a per-finding notification key
-- had nowhere to live (see migration 181). One GIN index serves both.
CREATE INDEX IF NOT EXISTS recommendations_finding_ids_gin
  ON recommendations USING GIN (finding_ids);

-- When the state last changed, so a decision stuck in 'executing' is
-- distinguishable from one that entered it a minute ago. `updated_at`
-- already exists but is touched by any write; this moves only with status.
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;

-- Guarded to be a no-op on re-run (migrations/run.js re-runs every file on
-- every deploy): only rows that have never had one are given a starting
-- value, and it is the row's own created_at rather than now(), so a
-- backfilled decision does not look as though it changed state at deploy
-- time.
UPDATE decisions SET status_changed_at = created_at WHERE status_changed_at IS NULL;
