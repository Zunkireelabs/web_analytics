-- Phase 3 (industry intelligence): knowledge shared ACROSS projects, keyed by industry.
--
-- This table is deliberately the opposite of everything else in the schema: it has NO site_id and NO workspace_id. A row says
-- something about an industry ("education"), never about a tenant. What a row may contain is limited at the code level
-- (server/lib/industry-intelligence.js): the industry and sub-industry labels come from a fixed catalog, `subject` is a
-- generator id or a curated practice key (lower-case slug), `claim` is built from those plus COUNTS, and `evidence` holds
-- only counts. No page URL, domain, query, draft text or client name is ever written here, so there is nothing to leak.
--
--   kind 'generator-outcome' — learned: how a kind of change tended to do across projects in this industry. Promoted to
--                              'validated' only when enough DISTINCT projects AND DISTINCT workspaces agree (see
--                              industry-intelligence.js). Observed association, never proven cause.
--   kind 'practice'          — curated starting-point guidance for the industry (SEO / GEO / AEO). Source 'curated', low
--                              confidence, status 'candidate' until our own results confirm it. Never presented as proven.
--
-- Status: candidate (not enough evidence yet) | validated | contradicted (projects disagree) | retired (no longer supported).
-- Validated learned rows carry expires_at so old knowledge stops being served unless it is re-confirmed.
--
-- Additive and idempotent, like every file here; no data statements.
CREATE TABLE IF NOT EXISTS industry_knowledge (
  id                BIGSERIAL   PRIMARY KEY,
  industry          TEXT        NOT NULL,
  sub_industry      TEXT        NOT NULL DEFAULT '',
  kind              TEXT        NOT NULL CHECK (kind IN ('generator-outcome', 'practice')),
  subject           TEXT        NOT NULL CHECK (subject ~ '^[a-z0-9][a-z0-9._-]*$'),
  surface           TEXT        NOT NULL DEFAULT 'general' CHECK (surface IN ('seo', 'geo', 'aeo', 'general')),
  polarity          TEXT        NOT NULL CHECK (polarity IN ('works', 'does-not-work', 'mixed', 'guidance')),
  claim             TEXT        NOT NULL,
  evidence          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  confidence        TEXT        NOT NULL DEFAULT 'low' CHECK (confidence IN ('low', 'medium', 'high')),
  status            TEXT        NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'validated', 'contradicted', 'retired')),
  source            TEXT        NOT NULL CHECK (source IN ('curated', 'cross-project')),
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ,
  UNIQUE (industry, sub_industry, kind, subject)
);
CREATE INDEX IF NOT EXISTS industry_knowledge_lookup_idx ON industry_knowledge (industry, status);

-- A project that does not want its outcomes counted toward shared industry knowledge. Contributing is opt-out; RECEIVING
-- industry knowledge is unaffected by this flag. Only aggregate counts are ever derived from a project, but the choice
-- belongs to the project's owner.
ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS share_industry_learning BOOLEAN NOT NULL DEFAULT true;

-- Same state as every other table in this schema (see 225): RLS on, no policies; the app connects as a role that bypasses it.
ALTER TABLE industry_knowledge ENABLE ROW LEVEL SECURITY;
