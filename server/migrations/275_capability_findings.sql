-- Self-repair: what the system found missing for a project (a blog target, front-matter defaults, a blog template, keyword discovery, a stalled blog
-- selection), the evidence, the repair it PROPOSES (never applied by this table: a person applies it through the existing audited path), and
-- whether it is still true. One row per (project, kind, subject); re-detecting updates last_seen, no longer detecting resolves it.
-- Additive: a new table only. Every row belongs to exactly one project (site_id), and every read and write is scoped by it.
CREATE TABLE IF NOT EXISTS capability_findings (
  id          BIGSERIAL PRIMARY KEY,
  site_id     INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',          -- open | resolved
  severity    TEXT NOT NULL DEFAULT 'warning',       -- critical | high | warning
  summary     TEXT NOT NULL,
  evidence    JSONB NOT NULL DEFAULT '{}'::jsonb,    -- facts the finding rests on (counts, ids, quoted refusal text), never invented
  proposal    JSONB,                                 -- the repair, validated, not applied: { action, patch?, steps[] , safe }
  blocker     TEXT,                                  -- what only a person can decide, when no safe repair exists
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT capability_findings_status_check CHECK (status IN ('open', 'resolved'))
);
CREATE UNIQUE INDEX IF NOT EXISTS capability_findings_key ON capability_findings (site_id, kind, subject);
CREATE INDEX IF NOT EXISTS capability_findings_open ON capability_findings (site_id) WHERE status = 'open';
