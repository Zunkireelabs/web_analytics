-- Action Center drafts: every generated recommendation lands here as a
-- draft, never applied to live content. `content` is structured JSON (shape
-- varies per action_type — e.g. FAQ = array of {question,answer}, not a
-- prose blob) so a future publish step can map fields programmatically
-- instead of re-parsing text. No publish_at/published column exists yet —
-- that's the deliberate extension point for a later phase, not built now.
CREATE TABLE IF NOT EXISTS drafts (
  id            SERIAL PRIMARY KEY,
  site_id       INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  action_type   TEXT NOT NULL,           -- 'meta-title' | 'faq' | 'schema' | 'internal-links' | 'blog-outline' | 'landing-page' | 'translation'
  source        TEXT,                    -- e.g. 'opportunity' | 'content-gap' | 'ai-visibility' | 'country-intelligence' | 'manual'
  input         JSONB NOT NULL,          -- grounding input the generator was called with (page url, query, topic, target language, etc.)
  content       JSONB NOT NULL,          -- generated draft content, structured per action_type
  status        TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'edited'
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drafts_site ON drafts (site_id, created_at DESC);
