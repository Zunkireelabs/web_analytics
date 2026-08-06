-- Corrective FK migration, same class of bug as 064. Migration 078 declared
-- execution_job_recommendations.draft_id as a bare `REFERENCES drafts(id)`,
-- which Postgres defaults to ON DELETE NO ACTION -- this silently blocks
-- DELETE FROM drafts (the Discard Draft action, server/store/drafts.js
-- deleteDraft) for any draft that was ever generated through the Execution
-- Engine ("Execute Today's Safe Fixes" / "Approve & Ship"), throwing a raw
-- FK-violation that surfaces to users as a generic "Internal server error".
--
-- -> SET NULL: preserves the historical execution-job record (what ran, when,
-- with what status) even after the draft it produced is discarded/reverted --
-- same "preserve history over the referenced row" reasoning drafts.approved_by
-- (024) and signup_requests.created_site_id (064) already use.

DO $$
DECLARE
  cname text;
BEGIN
  SELECT tc.constraint_name INTO cname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema = 'public'
    AND tc.table_name = 'execution_job_recommendations'
    AND kcu.column_name = 'draft_id'
    AND tc.constraint_type = 'FOREIGN KEY';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE execution_job_recommendations DROP CONSTRAINT %I', cname);
  END IF;

  ALTER TABLE execution_job_recommendations
    ADD CONSTRAINT execution_job_recommendations_draft_id_fkey
    FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE SET NULL;
END $$;
