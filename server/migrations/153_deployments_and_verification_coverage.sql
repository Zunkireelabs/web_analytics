-- Closes the last two stages of the autonomous chain: DEPLOY and VERIFY.
--
-- Until now a draft went pr_opened -> implemented the moment a human merged
-- the PR, and that was the end of the story. Two things were missing:
--
--   1. Nothing knew whether the merged change ever actually reached the live
--      site. "Merged" was silently treated as "shipped", so a merge that
--      never deployed (failed build on the client's host, paused deploy hook,
--      a branch that deploys nowhere) looked identical to a successful one.
--
--   2. Only 9 of 32 generator types had any post-merge re-check at all
--      (store/fix-verifications.js's VERIFIABLE_GENERATOR_IDS). For the other
--      23, "a human merged it" was the only outcome signal this app ever got.
--
-- `deployments` records the real post-merge deploy state per site, anchored to
-- the default branch's head SHA at the moment the merge was observed. It is
-- deliberately per (site_id, commit_sha) rather than per draft: one merge
-- commonly carries a whole day's batch, and they all deploy together.
CREATE TABLE IF NOT EXISTS deployments (
  id             SERIAL PRIMARY KEY,
  site_id        INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  commit_sha     TEXT NOT NULL,
  pr_number      INT,
  pr_url         TEXT,
  -- 'pending'  — merge observed, no evidence yet that it is live
  -- 'deployed' — a real live-site re-fetch found the shipped change present
  -- 'not-detected' — the grace window elapsed with no evidence it went live
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'deployed', 'not-detected')),
  merged_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deployed_at    TIMESTAMPTZ,
  evidence       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_deployments_site_status ON deployments (site_id, status);

-- Which deployment a given verification is waiting on, so "the change isn't
-- live yet" and "the change was deployed and is genuinely still broken" can
-- never be confused for one another.
ALTER TABLE fix_verifications ADD COLUMN IF NOT EXISTS deployment_id INT REFERENCES deployments(id) ON DELETE SET NULL;

-- How this row is to be verified, decided once at schedule time from the real
-- draft (see verificationMethodFor in store/fix-verifications.js) rather than
-- re-derived at check time, plus whatever concrete evidence that method needs
-- to look for (a header name, a well-known path, a verbatim excerpt of the
-- shipped content).
ALTER TABLE fix_verifications ADD COLUMN IF NOT EXISTS method   TEXT;
ALTER TABLE fix_verifications ADD COLUMN IF NOT EXISTS expected JSONB;

-- A row can legitimately be re-checked several times while a deploy is still
-- propagating; without a counter there is no way to stop waiting forever.
ALTER TABLE fix_verifications ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

-- Two honest new outcomes:
--   'awaiting-deployment' — re-checked, change not live YET, deploy still
--       inside its grace window. Re-scheduled, not a failure.
--   'unverifiable' — this change type has no evidence that can be checked
--       from outside (recorded WITH a reason). Explicitly not the same as
--       'verified-fixed'; nothing may ever be counted as verified by default.
ALTER TABLE fix_verifications DROP CONSTRAINT IF EXISTS fix_verifications_outcome_check;
ALTER TABLE fix_verifications ADD CONSTRAINT fix_verifications_outcome_check
  CHECK (outcome IN ('pending', 'verified-fixed', 'still-present', 'unreachable', 'awaiting-deployment', 'unverifiable'));

-- page_url was NOT NULL because every one of the original 9 verifiable types
-- had a real flagged page. Site-level changes (llms.txt, robots.txt,
-- sitemap.xml, security headers) verify against the site origin instead, and
-- repo-only changes (blog-image) have no public URL at all, so the column has
-- to be able to hold nothing for them.
ALTER TABLE fix_verifications ALTER COLUMN page_url DROP NOT NULL;
