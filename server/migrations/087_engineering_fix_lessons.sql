-- engineering_fix_lessons: a persisted, agent-readable record of recurring
-- application/code bug patterns ("don't do X again") so future bug fixes in
-- this repo don't repeat a mistake class already fixed once. Mirrors
-- fix_lessons (086) but for code, not content. Two consumers query this:
-- (1) Claude Code sessions working on this repo, filtered by applies_to
-- matching the file(s) being touched; (2) withEngineeringLessons() in
-- server/llm.js, an isolated callLLM-style hook mirroring withLessons(),
-- ready for a future code-modifying agent even though none exists yet.
-- Rows are added by the backfill script (server/scripts/backfill-engineering-
-- lessons.js) or by hand.
CREATE TABLE IF NOT EXISTS engineering_fix_lessons (
  id SERIAL PRIMARY KEY,
  bug_category TEXT NOT NULL,
  symptom TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  fix_pattern TEXT NOT NULL,
  applies_to TEXT NOT NULL,
  source_ref TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_engineering_fix_lessons_lookup
ON engineering_fix_lessons (bug_category) WHERE active;
