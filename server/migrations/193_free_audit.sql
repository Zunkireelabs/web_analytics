-- Free website audit (app.superrank.si/free-audit): saved reports and captured leads.
--
-- free_audit_reports holds the full audit for the private /free-audit/report?id=...
-- link. The id is an unguessable 32-hex capability, so there is no site or user
-- scope; rows are purged after 30 days (see server/store/free-audit.js).
-- free_audit_leads is every email that unlocked a report: the hand-off point for
-- the CRM later. Neither table touches tenant data.
--
-- Additive and idempotent; no data statements.

CREATE TABLE IF NOT EXISTS free_audit_reports (
  id TEXT PRIMARY KEY,
  site_url TEXT NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_free_audit_reports_created ON free_audit_reports (created_at);

CREATE TABLE IF NOT EXISTS free_audit_leads (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  site_url TEXT NOT NULL,
  report_id TEXT REFERENCES free_audit_reports(id) ON DELETE SET NULL,
  scores JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_free_audit_leads_created ON free_audit_leads (created_at);
