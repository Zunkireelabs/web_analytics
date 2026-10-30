-- design_choices: a fix the agent could not fit into the client's design on its own. The agent keeps trying (its
-- repair loop) and checks every attempt at desktop, tablet and phone width; when it truly cannot make the change
-- without breaking the page, nothing is published and a row lands here, with what it tried and a few options to pick
-- from. The person clicks one; the next scheduled run builds exactly that option (status 'chosen' -> 'building'), checks
-- it again, and only then opens the pull request, which a person still merges.
--
--   needs_choice  waiting for a person to pick an option
--   chosen        picked, waiting for the next run
--   building      the run has picked it up
--   shipped       a pull request was opened
--   withdrawn     picked, but still could not be built cleanly; it comes back as needs_choice with new options
--
-- One open row per idea (site_id + finding_id). attempts is the agent's own log: [{ what, result }]. options is
-- [{ key, name, note, tag? }], produced from the catalog in server/lib/fix-design-options.js.
-- Numbered 215 (213 content_picks, 214 brand colour). Additive and idempotent; no data statements.

CREATE TABLE IF NOT EXISTS design_choices (
  id            SERIAL PRIMARY KEY,
  site_id       INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  finding_id    TEXT NOT NULL,
  generator_id  TEXT NOT NULL,
  draft_id      INT,
  title         TEXT NOT NULL,
  page_url      TEXT,
  reason        TEXT,
  attempts      JSONB NOT NULL DEFAULT '[]',
  options       JSONB NOT NULL DEFAULT '[]',
  chosen_option TEXT,
  status        TEXT NOT NULL DEFAULT 'needs_choice' CHECK (status IN ('needs_choice', 'chosen', 'building', 'shipped', 'withdrawn')),
  chosen_by     INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  chosen_at     TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, finding_id)
);

CREATE INDEX IF NOT EXISTS idx_design_choices_site_status ON design_choices (site_id, status);
