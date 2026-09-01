-- Replaces the human design-review sign-off (migration 132) as the ship-time
-- gate. That gate blocked GLOBALLY: any site with design_review_at null (the
-- honest default for every pre-existing site, since no backfill ever ran)
-- had auto_remediation_enabled refused entirely, and separately had every
-- styled/net-new draft refused at apply time — producing the zero-PR cron
-- day this migration's change responds to.
--
-- verifyProfileRoles (design-drift.js) already does the thing the human
-- checkpoint was standing in for: it catches the exact zunkireelabs.com
-- incident class (a real class confirmed used for a DIFFERENT role, e.g.
-- body copy set to the site's eyebrow/label style), not just class
-- existence. This table is the log-only observation record — every verdict
-- it produces at ship time, per draft, kept regardless of whether the run
-- was in log or enforce mode — so the false-positive rate can be checked
-- against real, already-derived profiles before ENFORCE mode is turned on
-- (see the DESIGN_INTEGRITY_ENFORCE env var).
CREATE TABLE IF NOT EXISTS design_integrity_verdicts (
  id             SERIAL PRIMARY KEY,
  site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  finding_id     TEXT,
  action_type    TEXT,
  ok             BOOLEAN NOT NULL,
  reason         TEXT,
  field          TEXT,
  error_message  TEXT,
  enforced       BOOLEAN NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS design_integrity_verdicts_site_id_idx ON design_integrity_verdicts (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS design_integrity_verdicts_ok_idx ON design_integrity_verdicts (ok);
