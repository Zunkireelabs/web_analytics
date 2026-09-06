-- Cached LLM-generated "how our agents will grow you" narrative for the
-- Milestones page (server/agents/lib/growth-plan.js) — same sidecar-
-- staleness-column convention as daily_report_narrative_date (migration
-- 016): the narrative is only regenerated when the audit run it was based
-- on is no longer the latest completed one, not on every page view.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS growth_plan_narrative JSONB;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS growth_plan_narrative_generated_at TIMESTAMPTZ;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS growth_plan_narrative_audit_run_id INTEGER REFERENCES audit_runs(id);
