-- The shared, brand-free STRUCTURE reference for expand-content.
-- (server/design-agent/lib/expand-structure-spec.js, store/expand-structure.js)
--
-- Global reference data, deliberately NOT per-site config: the whole point is
-- one reference that many tenants can opt in to, versioned so a re-derivation
-- is a new row rather than an edit that silently changes every opted-in tenant.
--
-- It holds structure only — section count, role order, shape, heading level,
-- table usage, placement rule. The identity firewall in the module rejects
-- any class, colour or length before a row can be written, so nothing in this
-- table can leak one client's look into another's.
--
-- derived_from_site_id is a pointer for provenance, not a join target: the
-- source site may later be deleted and the reference must survive it.
CREATE TABLE IF NOT EXISTS expand_structure_specs (
  id                   SERIAL PRIMARY KEY,
  version              INTEGER NOT NULL,
  spec                 JSONB NOT NULL,
  derived_from_site_id INTEGER,
  pages_observed       INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per version; a re-derivation bumps it.
CREATE UNIQUE INDEX IF NOT EXISTS expand_structure_specs_version ON expand_structure_specs (version);
