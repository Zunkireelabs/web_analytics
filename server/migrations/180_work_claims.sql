-- One owner per page/keyword/topic at a time (server/agents/lib/work-claims.js).
--
-- Nine separate producers can propose work for the same site in one day: the
-- daily agent roster, analyst-sync, analyst-fusion, the weekly
-- growth-opportunities sync, the keyword-gap ship cycle, content-repair,
-- template-capability-repair, learned-repair and the design-agent queue.
--
-- The existing dedup authority is the partial unique index on
-- recommendations (077b): (site_id, page, recommendation_type) WHERE
-- status='open'. That key includes the TYPE, which is correct for its own
-- question ("is this exact card already on the board?") and insufficient for
-- this one: a meta-title fix and an expand-content fix on the same page are
-- two different recommendation_types, so both are created, both are drafted,
-- and both edit the same file in the same hour. Worse, four of the nine
-- producers above write drafts or shipping_queue rows WITHOUT a
-- recommendation row at all, so they are invisible to that index entirely.
--
-- Hence the index below OMITS the generator and the type. That omission is
-- the entire point of this table. Both indexes are kept: they answer
-- different questions and neither subsumes the other.
--
--   scope      'page' | 'keyword' | 'topic'
--   scope_key  normalized page path, keyword, or topic slug — never a raw URL
--              (see normalizeScopeKey; www/trailing-slash/case differences
--              must not create two owners for one thing)
--   intent     what the producer means to DO, which is what makes arbitration
--              possible: 'new-blog' and 'expand-existing' on the same topic
--              are not duplicates by type, they are two answers to one
--              question, and exactly one of them should happen.
--
-- expires_at exists because a producer can die mid-run (a closed laptop, an
-- OOM-killed container) and must not hold a page forever. A claim past its
-- expiry is flipped to 'expired' by expireStaleClaims (run from the hourly
-- reconcile lane) and by a targeted sweep inside claimWork itself, so a dead
-- producer never permanently starves a live one. Same reasoning, and the same
-- lease-rather-than-lock shape, as job_locks (147).
--
-- Schema only, additive and idempotent — this directory re-runs every file on
-- every deploy.
CREATE TABLE IF NOT EXISTS work_claims (
  id BIGSERIAL PRIMARY KEY,
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  intent TEXT NOT NULL,
  producer TEXT NOT NULL,
  generator_id TEXT,
  recommendation_id BIGINT,
  draft_id BIGINT,
  status TEXT NOT NULL DEFAULT 'open',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

ALTER TABLE work_claims DROP CONSTRAINT IF EXISTS work_claims_scope_check;
ALTER TABLE work_claims ADD CONSTRAINT work_claims_scope_check
  CHECK (scope IN ('page', 'keyword', 'topic'));

ALTER TABLE work_claims DROP CONSTRAINT IF EXISTS work_claims_status_check;
ALTER TABLE work_claims ADD CONSTRAINT work_claims_status_check
  CHECK (status IN ('open', 'done', 'released', 'expired', 'superseded'));

-- The whole guarantee, in one index. A second producer's INSERT ... ON
-- CONFLICT DO NOTHING against this returns no row, which is how it learns it
-- lost — one round trip, no SELECT to race against, exactly the technique
-- job-lock.js's tryAcquire uses.
CREATE UNIQUE INDEX IF NOT EXISTS work_claims_open_key
  ON work_claims (site_id, scope, scope_key) WHERE status = 'open';

-- For the expiry sweep.
CREATE INDEX IF NOT EXISTS work_claims_expiry_idx
  ON work_claims (expires_at) WHERE status = 'open';

-- For "what is this producer holding right now", and for release-by-draft
-- when a draft terminates.
CREATE INDEX IF NOT EXISTS work_claims_site_status_idx
  ON work_claims (site_id, status, created_at DESC);
