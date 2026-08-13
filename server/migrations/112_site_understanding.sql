-- Site Understanding: what the discovery engine has established about a
-- client's repository, with the evidence behind it (Phase 2, §7/§8).
--
-- Deliberately a NEW table rather than more keys on sites.url_file_map, and
-- deliberately not site_profiles (080), which is Claude's search-query-derived
-- semantic profile — a different subject (what the business is about) from
-- this one (how the repository is built). Keeping them apart avoids one
-- table with two unrelated owners and two update cadences.
--
-- url_file_map remains the single source of truth for CONFIGURATION that the
-- implementers read. This table holds DISCOVERY: the findings, their evidence,
-- their confidence, and whether a human has confirmed them. Safe findings are
-- projected INTO url_file_map (see discovery/auto-configure.js); this table
-- records why that projection was justified, which url_file_map has nowhere
-- to put and should not carry.

CREATE TABLE IF NOT EXISTS site_understanding (
  id             SERIAL PRIMARY KEY,
  site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,

  -- What KIND of thing was discovered ('technology', 'page-type',
  -- 'shared-infrastructure', 'data-source', 'design-profile',
  -- 'insertion-point'). Open text rather than an enum: the discovery engine
  -- is expected to learn new categories, and a migration per category would
  -- make that needlessly expensive.
  category       TEXT NOT NULL,

  -- Stable identity of the specific thing within its category (a framework
  -- id, a directory path, a file path). Together with category+site this is
  -- what makes a re-run an UPDATE rather than an ever-growing log.
  subject        TEXT NOT NULL,

  -- The finding itself, shaped per category by the discovery modules.
  finding        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Why this was concluded: [{kind, detail, source}]. A finding with no
  -- evidence is not a finding — see the CHECK below.
  evidence       JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- 0.00-1.00, matching agent_fix_memory's numeric convention rather than
  -- render-inspector's 0-100 integer one. Derived from corroborating
  -- evidence, never asserted by a model on its own (§9).
  confidence     NUMERIC(3,2) NOT NULL DEFAULT 0.00,

  -- Blast radius if this were acted on: 'low' | 'medium' | 'high'.
  risk           TEXT NOT NULL DEFAULT 'medium',

  -- Lifecycle (§14). Per-FINDING, not per-onboarding, which is what lets one
  -- uncertain item sit in needs_confirmation while everything else is ready.
  --   discovered        - found, not yet validated
  --   validated         - corroborated by a second check
  --   auto_configured   - proven safe and written into url_file_map
  --   needs_confirmation- real ambiguity a human must resolve
  --   confirmed         - a human chose; never re-asked (§12)
  --   rejected          - a human said no; never re-proposed
  status         TEXT NOT NULL DEFAULT 'discovered'
                 CHECK (status IN ('discovered','validated','auto_configured','needs_confirmation','confirmed','rejected')),

  -- Set only when a human resolves an ambiguity, so learned decisions are
  -- attributable and can outlive the person who made them.
  confirmed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at   TIMESTAMPTZ,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A finding must carry evidence unless a human explicitly decided it. This
  -- is the schema-level expression of §8: the system may not record a belief
  -- it cannot justify. Enforced in SQL rather than convention because the
  -- whole value of this table collapses if unevidenced rows can enter it.
  CONSTRAINT site_understanding_evidence_required
    CHECK (jsonb_array_length(evidence) > 0 OR status IN ('confirmed','rejected')),

  CONSTRAINT site_understanding_risk_valid CHECK (risk IN ('low','medium','high'))
);

-- One row per (site, category, subject): a re-run refreshes a finding in
-- place instead of appending a duplicate, which is what makes the second run
-- cheap and idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS site_understanding_unique_subject
  ON site_understanding (site_id, category, subject);

CREATE INDEX IF NOT EXISTS site_understanding_site_status
  ON site_understanding (site_id, status);
