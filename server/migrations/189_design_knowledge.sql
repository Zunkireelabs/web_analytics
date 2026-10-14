-- Tenant-specific DESIGN knowledge, kept in the existing agent_fix_memory
-- store rather than a parallel table: one lessons store, one confidence /
-- occurrence / reuse mechanism, one place to look.
--
--   category 'design'  — a lesson about how THIS tenant's pages are built.
--                        Always site-scoped (site_id set); the reader
--                        (store/design-knowledge.js) never returns a NULL-site
--                        wildcard row, and findRelevantMemory excludes the
--                        category unless it is asked for by name, so a design
--                        lesson can never leak into another client's prompt.
--   lesson_kind        — 'fix' (an approach that was validated) or
--                        'anti-pattern' (an approach that was tried and did
--                        not hold). Failed attempts are knowledge too.
--   design_context     — what the flat columns cannot hold: page type, page
--                        family, component, evidence, affected files,
--                        validation result, baseline and measured impact.
--
-- Schema only, idempotent: run.js re-applies this on every deploy.
ALTER TABLE agent_fix_memory DROP CONSTRAINT IF EXISTS agent_fix_memory_category_check;
ALTER TABLE agent_fix_memory ADD CONSTRAINT agent_fix_memory_category_check
  CHECK (category IN ('content','technical-seo','code','data-analytics','infrastructure','other','design'));

ALTER TABLE agent_fix_memory ADD COLUMN IF NOT EXISTS lesson_kind TEXT NOT NULL DEFAULT 'fix';
ALTER TABLE agent_fix_memory DROP CONSTRAINT IF EXISTS agent_fix_memory_lesson_kind_check;
ALTER TABLE agent_fix_memory ADD CONSTRAINT agent_fix_memory_lesson_kind_check
  CHECK (lesson_kind IN ('fix','anti-pattern'));
ALTER TABLE agent_fix_memory ADD COLUMN IF NOT EXISTS design_context JSONB;

CREATE INDEX IF NOT EXISTS idx_agent_fix_memory_design
  ON agent_fix_memory (site_id, lesson_kind) WHERE category = 'design' AND status != 'deprecated';
