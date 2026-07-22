-- Full Site Audit infrastructure (see the ai-growth-platform Website
-- Intelligence plan, Phase 5). Deliberately new, dedicated tables rather than
-- overloading agent_runs — a full-site audit's whole value is site-wide
-- querying/aggregation across hundreds of pages, which agent_runs' one-
-- JSONB-blob-per-row shape can't answer without deserializing every row.
-- Same "new mode -> new sibling table" precedent as migration 042
-- (agentic_orchestration_runs).
CREATE TABLE IF NOT EXISTS audit_runs (
  id                SERIAL PRIMARY KEY,
  site_id           INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  mode              TEXT NOT NULL CHECK (mode IN ('full', 'continuous')),
  triggered_by      TEXT NOT NULL CHECK (triggered_by IN ('manual', 'scheduled')),
  status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'partial')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  pages_discovered  INT NOT NULL DEFAULT 0,
  pages_audited     INT NOT NULL DEFAULT 0,
  agent_ids_run     TEXT[] NOT NULL DEFAULT '{}',
  health_score      INT,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_runs_site ON audit_runs (site_id, started_at DESC);

-- One row per finding, not a JSONB blob per page — the point of a full-site
-- audit is querying/aggregating across pages (e.g. "every high-priority
-- accessibility finding, sorted by page"), which needs relational rows.
-- `page` is nullable: a handful of findings (duplicate-title groups,
-- broken-link crawls) genuinely span multiple pages rather than belonging to
-- one — storing NULL for those is more honest than forcing a fake single page.
CREATE TABLE IF NOT EXISTS audit_page_findings (
  id                  SERIAL PRIMARY KEY,
  audit_run_id        INT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
  site_id             INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  agent_id            TEXT NOT NULL,
  page                TEXT,
  finding_id          TEXT NOT NULL,
  priority            TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  evidence            JSONB,
  why_it_matters      TEXT,
  recommended_action  JSONB,
  expected_impact     JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_page_findings_run ON audit_page_findings (audit_run_id);
CREATE INDEX IF NOT EXISTS idx_audit_page_findings_page ON audit_page_findings (site_id, page);
CREATE INDEX IF NOT EXISTS idx_audit_page_findings_category ON audit_page_findings (site_id, agent_id, priority);

-- Attributes of an already-known page (page_inventory, migration 027), not a
-- new entity — extended rather than a new table.
ALTER TABLE page_inventory ADD COLUMN IF NOT EXISTS http_status INT;
ALTER TABLE page_inventory ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE page_inventory ADD COLUMN IF NOT EXISTS last_full_audit_at TIMESTAMPTZ;
