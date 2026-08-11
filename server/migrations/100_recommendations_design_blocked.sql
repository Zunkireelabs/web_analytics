-- Design-verification gate (implementers/lib/design-drift.js's
-- componentTemplateVerification + routes/action-center.js's generateDraft).
--
-- A recommendation whose action type needs a component template (faq,
-- expand-content, internal-links, qa-content, content-wrapper) can no longer
-- become a draft until that template has been verified against the site's
-- real design. Before this, such a recommendation was drafted anyway using
-- marker-merge.js's zero-config DEFAULT_* fallback and typically failed at
-- apply time — a silent, repeated waste that read to the user as "the agent
-- keeps trying the same broken fix."
--
-- The blocked recommendation deliberately stays VISIBLE and open rather than
-- being filtered out of buildRecommendations the way the url_file_map /
-- file-exists / adapter-data gates drop their items: those three mean "this
-- can never apply, stop showing it," whereas this one means "this is a real
-- detected issue we are not yet allowed to auto-fix" — hiding it would lose
-- a genuine finding. It is surfaced with a reason and forced to the 'manual'
-- risk tier (recommendation-coordinator.js) so it stays out of the
-- unattended safe-fix chain while remaining actionable by a human.
--
-- NULL = not blocked, which is the correct reading for every existing row.
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS design_blocked_reason TEXT;

CREATE INDEX IF NOT EXISTS recommendations_design_blocked_idx
  ON recommendations (site_id) WHERE design_blocked_reason IS NOT NULL;
