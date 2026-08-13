-- Makes a draft deletable again once an execution job has touched it.
--
-- 078 declared `draft_id INTEGER REFERENCES drafts(id)` with no ON DELETE
-- action, which defaults to NO ACTION — so any attempt to delete a draft that
-- an execution job recorded fails with a foreign-key violation. Every draft the
-- autonomous chain creates has such a row (shipRecommendation calls
-- addJobRecommendation before generateDraft), which means in practice EVERY
-- autonomously-created draft is undeletable: store/drafts.js's deleteDraft
-- throws, and the Action Center's own Delete button 500s. Found by trying to
-- delete draft #580 on site 1.
--
-- It only got worse as autonomy grew — before the execution engine existed,
-- drafts had no job rows and deleted cleanly.
--
-- SET NULL rather than CASCADE, deliberately. These rows are the audit trail of
-- what a job attempted and what happened to each item; deleting a draft should
-- not erase the record that a job tried it, nor should that record veto the
-- deletion. Nulling the link keeps the history (job, recommendation, status,
-- error) and lets the draft go. The column was already nullable — a
-- job-recommendation row is created BEFORE its draft exists, so NULL is an
-- ordinary, expected value here, not a new state readers have to learn.

ALTER TABLE execution_job_recommendations
  DROP CONSTRAINT IF EXISTS execution_job_recommendations_draft_id_fkey;

ALTER TABLE execution_job_recommendations
  ADD CONSTRAINT execution_job_recommendations_draft_id_fkey
  FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE SET NULL;
