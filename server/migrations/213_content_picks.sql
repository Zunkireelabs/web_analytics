-- content_picks: a person's one-click choice on a content idea the agent found (a landing page, a translation, a blog
-- post). Saving a pick IS the approval: nothing is built when it is saved. The next scheduled run reads the rows that
-- are still 'saved', builds exactly the chosen option, and opens one pull request, which a person still merges.
--
-- One pick per idea (site_id + finding_id): choosing again replaces it, clearing deletes it. finding_id is the
-- recommendation's own finding key (the same one /action-center/generate takes). status is what the run does with it:
--   saved      chosen, waiting for the next run
--   building   the run has picked it up
--   shipped    a pull request was opened for it
--   withdrawn  the run could not build it without breaking the design; it goes back to the person with new options
--
-- Numbered 213: feature/workspace ends at 212. Additive and idempotent; no data statements.

CREATE TABLE IF NOT EXISTS content_picks (
  id            SERIAL PRIMARY KEY,
  site_id       INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  finding_id    TEXT NOT NULL,
  generator_id  TEXT NOT NULL,
  option_key    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'saved' CHECK (status IN ('saved', 'building', 'shipped', 'withdrawn')),
  chosen_by     INT,
  chosen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, finding_id)
);

CREATE INDEX IF NOT EXISTS idx_content_picks_site_status ON content_picks (site_id, status);
