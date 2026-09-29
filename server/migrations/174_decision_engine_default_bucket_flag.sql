-- Per-site opt-in for the scoped Decision Engine integration (migration
-- 173, server/agents/lib/default-bucket-decision.js). Same shape as
-- auto_remediation_enabled (089): default OFF, one tenant enabled at a time
-- by hand, never a global default — this is an experimental integration of
-- decision-engine.js into the main recommendation path, not a replacement
-- for any existing deterministic classifier or safety gate, and the
-- architecture audit's own rollout instruction is "enable it for exactly
-- one test tenant first."
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS decision_engine_default_bucket_enabled BOOLEAN NOT NULL DEFAULT false;
