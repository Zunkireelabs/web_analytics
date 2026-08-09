-- Design Agent -> componentTemplates integration: a design_generate job
-- needs somewhere to carry which action types/component keys were
-- requested (params, set at creation) and what the agent actually derived
-- (result, set on completion) — neither existed on execution_jobs before
-- this. Both nullable/defaulted so every existing row and every existing
-- caller (createExecutionJob, the fixture-demo design_generate path) is
-- unaffected: params defaults to '{}', result defaults to NULL (a job that
-- never ran, or ran before this migration, simply has no result yet).
ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}';
ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS result JSONB;
