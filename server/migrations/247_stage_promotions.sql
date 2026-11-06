-- SRANK-47 follow-up: remembers which merged stage pull requests have already been promoted to main for a client repository, so the
-- agent opens the stage -> main promotion PR exactly once for each batch a person merged on stage (lib/stage-promotion.js).
-- Additive and idempotent. `status`: 'opened' (a promotion PR exists), 'waiting' (stage's build check is still running), 'blocked'
-- (stage's build check failed, nothing opened). The agent never merges the promotion PR; a person does.
CREATE TABLE IF NOT EXISTS stage_promotions (
  site_id              INT         NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source_pr_number     INT         NOT NULL,
  status               TEXT        NOT NULL CHECK (status IN ('opened', 'waiting', 'blocked')),
  promotion_pr_number  INT,
  promotion_pr_url     TEXT,
  note                 TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, source_pr_number)
);
ALTER TABLE stage_promotions ENABLE ROW LEVEL SECURITY;
