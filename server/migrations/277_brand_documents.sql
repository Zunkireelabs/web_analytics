-- 277: brand documents a project's own people add (brand guidelines, tone of voice, product notes, topics they want covered).
-- The agents that write for this project read them as grounding, for THIS project only (site_id is the only key; nothing here is shared across projects).
-- Plain text only: the page reads a .txt/.md file in the browser, or the person pastes the text. Capped in the route, not here.
CREATE TABLE IF NOT EXISTS brand_documents (
  id          BIGSERIAL PRIMARY KEY,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  content     TEXT NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brand_documents_site_idx ON brand_documents (site_id, created_at DESC);

-- "About the brand": what the company is, in its own words, one text per project. Read by the agents together with the documents.
CREATE TABLE IF NOT EXISTS brand_about (
  site_id     INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  about       TEXT NOT NULL DEFAULT '',
  updated_by  INTEGER,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
