-- Prompt 7 audit: drafts.finding_id had NO uniqueness guarantee at all —
-- only the application-level check-then-insert in generateDraft()
-- (getDraftByFindingId, then createDraft) stood between two concurrent
-- callers targeting the same finding and two duplicate draft rows. This
-- window is real, not hypothetical: the two Analyst->Node paths
-- (drafts.py's direct MCP generate_draft push, and Node's own
-- syncAnalystInsightsToActionCenter -> auto-remediation.js pull) can both
-- reach generateDraft() for the identical finding_id close enough together
-- that both getDraftByFindingId reads land before either INSERT commits —
-- the window between them spans up to two LLM generation attempts, the
-- Quality Gate, and Design Agent resolution, not a single atomic step.
--
-- The index must mirror getDraftByFindingId/getDraftedFindingIds
-- (store/drafts.js), which both already treat an 'abandoned' draft's
-- finding_id as reopened/reusable — a finding is free to be redrafted once
-- its prior draft is abandoned. Scoping uniqueness to non-abandoned rows
-- (rather than to every row with a finding_id) keeps that behavior intact:
-- otherwise regenerating a draft after abandonment would hit this
-- constraint even though the app-level check-then-insert would have
-- allowed it, failing generateDraft() after its LLM call already ran.
--
-- Defensive pre-cleanup first: null out finding_id on every duplicate
-- EXCEPT the most recent non-abandoned row per (site_id, finding_id), or
-- the most recent row overall if every row for that finding_id is
-- abandoned — rather than deleting real draft rows sight-unseen. A
-- drafts.finding_id going null only means that specific row stops being
-- reachable by finding-id lookups (e.g. getDraftByFindingId,
-- getImplementedFindingIds) — it does not touch the row's own
-- content/status/PR history.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY site_id, finding_id
    ORDER BY (status <> 'abandoned') DESC, created_at DESC, id DESC
  ) AS rn
  FROM drafts
  WHERE finding_id IS NOT NULL
)
UPDATE drafts SET finding_id = NULL
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS drafts_site_finding_id_unique
  ON drafts (site_id, finding_id)
  WHERE finding_id IS NOT NULL AND status <> 'abandoned';
