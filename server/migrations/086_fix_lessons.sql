-- fix_lessons: a persisted, agent-readable record of recurring mistake
-- classes ("don't do X again") so every LLM-backed generator can be told
-- about a known issue BEFORE it drafts, instead of the same class of
-- schema/content bug resurfacing on a later page/run and someone having to
-- re-explain the same correction. generator_id NULL = applies to every
-- generator; site_id NULL = applies to every tenant. Rows are typically
-- added by hand (an admin/agent recording a lesson learned from a real
-- fix) or by fix-verification.js when a previously "fixed" issue is found
-- to have regressed (source = 'regression') — see server/lessons.js.
CREATE TABLE IF NOT EXISTS fix_lessons (
  id SERIAL PRIMARY KEY,
  generator_id TEXT,
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  lesson TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fix_lessons_lookup ON fix_lessons (generator_id, site_id) WHERE active;
