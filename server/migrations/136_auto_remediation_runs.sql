-- Persists what console-only logging couldn't answer after the fact: which
-- of the three stop conditions in auto-remediation.js's shipping loop
-- (circuit-breaker, refusal-streak, github-rate-limited) or the four early
-- exits (disabled, onboarding-analysis-pending, budget-exhausted,
-- global-ceiling-reached) ended a given run, and how far it got before that.
-- Investigated live on 2026-09-02: a run shipped 45/60 of its daily budget
-- (44 blog-image + 1 meta-title) and stopped, with 570 other open safe-tier
-- recommendations untouched — the DB had no way to say why, only
-- server console logs did, and those aren't queryable after the fact.
--
-- One row per autoRemediateSafeRecommendations() call, same log-only shape as
-- design_integrity_verdicts (migration 134) — never read by the shipping path
-- itself, only by a human or the Assistant asking "what happened this run".
CREATE TABLE IF NOT EXISTS auto_remediation_runs (
  id             SERIAL PRIMARY KEY,
  site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  started_at     TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ NOT NULL,
  attempted      INTEGER NOT NULL DEFAULT 0,
  shipped        INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  refused        INTEGER NOT NULL DEFAULT 0,
  skipped        INTEGER NOT NULL DEFAULT 0,
  spent_today    INTEGER,
  daily_limit    INTEGER,
  stopped_reason TEXT,
  pr_url         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auto_remediation_runs_site_started_idx ON auto_remediation_runs (site_id, started_at DESC);
