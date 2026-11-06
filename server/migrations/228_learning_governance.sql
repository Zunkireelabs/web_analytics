-- Phase 6 (governance of cross-project learning).
--
-- 1. REVIEW. A person can hold back or reject a piece of shared industry knowledge that looks wrong, and later restore it.
--    review_state 'auto' (never reviewed) | 'approved' | 'quarantined' (hidden while someone checks) | 'rejected' (judged invalid).
--    Quarantined and rejected rows are never served to a project and are never promoted again by a refresh; the refresh keeps
--    recording evidence on them so a reviewer can see what the data says now. Every review needs a reviewer and a reason.
--
-- 2. LOG. industry_knowledge_log is an append-only history of how shared knowledge changed and why: created, status /
--    polarity / confidence changes, retirement, reviews. Like industry_knowledge itself it has NO site_id and NO workspace_id
--    and holds only the same counts-only evidence, so the audit trail cannot leak a tenant. knowledge_id is SET NULL on
--    delete and the identifying columns are copied, so history survives the row.
--
-- Additive and idempotent, like every file here; no data statements.
ALTER TABLE industry_knowledge ADD COLUMN IF NOT EXISTS review_state  TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE industry_knowledge ADD COLUMN IF NOT EXISTS reviewed_by   TEXT;
ALTER TABLE industry_knowledge ADD COLUMN IF NOT EXISTS reviewed_at   TIMESTAMPTZ;
ALTER TABLE industry_knowledge ADD COLUMN IF NOT EXISTS review_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'industry_knowledge_review_state_check') THEN
    ALTER TABLE industry_knowledge ADD CONSTRAINT industry_knowledge_review_state_check
      CHECK (review_state IN ('auto', 'approved', 'quarantined', 'rejected'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS industry_knowledge_log (
  id            BIGSERIAL   PRIMARY KEY,
  knowledge_id  BIGINT      REFERENCES industry_knowledge(id) ON DELETE SET NULL,
  industry      TEXT        NOT NULL,
  sub_industry  TEXT        NOT NULL DEFAULT '',
  kind          TEXT        NOT NULL,
  subject       TEXT        NOT NULL,
  event         TEXT        NOT NULL CHECK (event IN ('created', 'changed', 'retired', 'reviewed')),
  from_status   TEXT,
  to_status     TEXT,
  from_polarity TEXT,
  to_polarity   TEXT,
  from_confidence TEXT,
  to_confidence TEXT,
  review_state  TEXT,
  evidence      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  reason        TEXT        NOT NULL DEFAULT '',
  actor         TEXT        NOT NULL DEFAULT 'system',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS industry_knowledge_log_subject_idx ON industry_knowledge_log (industry, sub_industry, kind, subject, created_at DESC);
CREATE INDEX IF NOT EXISTS industry_knowledge_log_created_idx ON industry_knowledge_log (created_at DESC);

ALTER TABLE industry_knowledge_log ENABLE ROW LEVEL SECURITY;
