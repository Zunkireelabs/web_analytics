-- THE CONTENT INDEX AND THE TOPIC DECISION LOG (Phases 5, 6 and 7).
--
-- content_index: for each project, every piece of content the system must never duplicate or overwrite, in five states:
--   published  a live page on the site's own domain that is a blog post (found from page inventory + the page-content classification cache +
--              the schema/og signals of the latest crawl snapshot; NEVER from URL patterns alone: Admizz's 59 posts live at the site root)
--   draft      a draft awaiting approval (draft / edited / submitted_for_approval / revision_requested)
--   approved   approved or pushed to a branch, no pull request yet (approved / branch_pushed / awaiting_publish)
--   in_pr      its pull request is open (pr_opened, pr_state not merged/closed) or it is merged to the stage branch
--   merged     its pull request is merged (implemented / pr_state merged)
-- A row is keyed by `ref_key` ('url:<normalised url>' for a live page, 'draft:<id>' for a draft) so a draft that is published later is
-- the SAME topic seen in two states, and the check says which one matched. The table is a snapshot the checks read; it is rebuilt from the
-- real sources (page_inventory, seo_page_snapshots, page_content_classification, drafts) by lib/content-index/store.js, never edited by hand.
-- file_path / file_sha record the file an item was written against (the "what did you read" half of overwrite protection).
--
-- topic_decisions: the audit log of every blog topic the system decided about: accepted, rejected or deferred, with the gate-by-gate
-- reasons, the evidence it used, the business-relevance reasoning, a priority, and the alternatives it turned down and why. A person can
-- read any choice back. Written by lib/blog-cycle and lib/topic-research; never read by the shipping path except through those modules.
--
-- Additive and idempotent, like every file here; no data statements.

CREATE TABLE IF NOT EXISTS content_index (
  id            BIGSERIAL PRIMARY KEY,
  site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  ref_key       TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'blog',
  state         TEXT NOT NULL,
  url           TEXT,
  title         TEXT,
  topic_key     TEXT,
  tokens        TEXT[] NOT NULL DEFAULT '{}',
  source        TEXT NOT NULL,
  draft_id      INTEGER,
  branch_name   TEXT,
  pr_url        TEXT,
  file_path     TEXT,
  file_sha      TEXT,
  content_hash  TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_index_state_check CHECK (state IN ('published', 'draft', 'approved', 'in_pr', 'merged')),
  CONSTRAINT content_index_site_ref_unique UNIQUE (site_id, ref_key)
);

CREATE INDEX IF NOT EXISTS content_index_site_state_idx ON content_index (site_id, state);
CREATE INDEX IF NOT EXISTS content_index_site_topic_idx ON content_index (site_id, topic_key);
CREATE INDEX IF NOT EXISTS content_index_site_path_idx ON content_index (site_id, file_path) WHERE file_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS topic_decisions (
  id                BIGSERIAL PRIMARY KEY,
  site_id           INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  cycle_date        DATE NOT NULL,
  topic             TEXT NOT NULL,
  topic_key         TEXT,
  decision          TEXT NOT NULL,
  origin            TEXT NOT NULL DEFAULT 'gate',
  gates             JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence          JSONB NOT NULL DEFAULT '{}'::jsonb,
  relevance         JSONB,
  priority          NUMERIC,
  alternatives      JSONB NOT NULL DEFAULT '[]'::jsonb,
  enforced          BOOLEAN NOT NULL DEFAULT false,
  recommendation_id INTEGER,
  draft_id          INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT topic_decisions_decision_check CHECK (decision IN ('accepted', 'rejected', 'deferred'))
);

CREATE INDEX IF NOT EXISTS topic_decisions_site_day_idx ON topic_decisions (site_id, cycle_date DESC, decision);
CREATE INDEX IF NOT EXISTS topic_decisions_site_topic_idx ON topic_decisions (site_id, topic_key);
