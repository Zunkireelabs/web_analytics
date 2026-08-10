-- Phase 5 of the Quality Gate work (089-091): upgrades fix_lessons (086)
-- from free-text "title + lesson" rows into structured, reusable fix
-- knowledge an occurrence can be measured against, not just prose a human
-- has to re-read. Extends the existing table rather than adding a parallel
-- one — same concept (a generator-readable correction), richer shape.
--
-- occurrence_count/status is what makes "the same issue observed
-- repeatedly becomes a stronger rule" a real, queryable fact instead of a
-- vibe: every confirmed recurrence of the same (generator_id, site_id,
-- validation_rule_id) increments occurrence_count instead of inserting a
-- duplicate row (see lessons.js's addLesson), and crossing
-- AUTO_RULE_THRESHOLD flips status from 'candidate' to 'auto_rule'.
-- override_count is the inverse signal — a human undoing the same class of
-- automatic fix repeatedly demotes status to 'flagged_for_review' instead
-- of the rule continuing to apply unchanged and unnoticed.
ALTER TABLE fix_lessons ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE fix_lessons ADD COLUMN IF NOT EXISTS root_cause TEXT;
ALTER TABLE fix_lessons ADD COLUMN IF NOT EXISTS confidence NUMERIC(3,2) NOT NULL DEFAULT 0.50;
ALTER TABLE fix_lessons ADD COLUMN IF NOT EXISTS validation_rule_id TEXT;
ALTER TABLE fix_lessons ADD COLUMN IF NOT EXISTS affected_generators TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE fix_lessons ADD COLUMN IF NOT EXISTS occurrence_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fix_lessons ADD COLUMN IF NOT EXISTS override_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fix_lessons ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'candidate';
ALTER TABLE fix_lessons ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE fix_lessons DROP CONSTRAINT IF EXISTS fix_lessons_status_check;
ALTER TABLE fix_lessons ADD CONSTRAINT fix_lessons_status_check
  CHECK (status IN ('candidate', 'auto_rule', 'flagged_for_review'));

-- Lookup for "does an active rule already exist for this exact recurring
-- issue" (lessons.js's addLesson dedup) — generator_id/site_id/
-- validation_rule_id can each be NULL (wildcard), so this can't be a
-- UNIQUE constraint; a plain index is enough since the dedup query itself
-- always filters on `active`.
CREATE INDEX IF NOT EXISTS idx_fix_lessons_rule_lookup ON fix_lessons (validation_rule_id, generator_id, site_id) WHERE active;

-- Which validation-rule hits this draft's generation self-corrected on
-- (server/agents/lib/draft-lesson-extraction.js's pattern-id vocabulary),
-- persisted so approveAndPublishDraft can later confirm-or-not the lesson
-- that got recorded at generation time — a draft reaching real approval
-- with no further human edit is the "successful resolution, confirmed by
-- outcome" signal occurrence_count above is measuring.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS gate_resolved_patterns TEXT[];
