-- insertion_strategies: the universal insertion engine's learning layer
-- (server/implementers/lib/strategy-registry.js). Caches "where does content
-- safely go in this file" so a repeat call doesn't re-run AST/DOM detection,
-- and — the actual point of "learn once, reuse across a shared template" —
-- lets a page keyed by template_identity (server/implementers/lib/
-- template-identity.js: a shared layout/base/component resolved from a real
-- front-matter `layout:` field, a real `{% extends %}`/`@extends()`
-- statement, or a real resolved `import`) inherit an already-proven
-- strategy from a DIFFERENT page's source file the first time it's needed,
-- instead of re-earning structural confidence independently (which a
-- brand-new/thin page might not have enough of its own content to do).
--
-- One row per (site_id, file_path) — file_path is always the page this row
-- was learned/last validated from; template_identity is nullable (a
-- standalone page with no detectable shared layout only ever gets looked up
-- by its own file_path). structural_signature is a cheap shape fingerprint
-- (fileKind + containerDescription, NOT the raw byte offset, which is always
-- page-specific) used to detect drift: if a file's current signature no
-- longer matches its stored row, the row is stale (template redesign) and
-- re-detection runs automatically — see strategy-registry.js's invalidation
-- step.
CREATE TABLE IF NOT EXISTS insertion_strategies (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  template_identity TEXT,
  structural_signature TEXT NOT NULL,
  file_kind TEXT NOT NULL,
  container_description TEXT,
  confidence TEXT NOT NULL DEFAULT 'high',
  last_validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_insertion_strategies_template
ON insertion_strategies (site_id, template_identity) WHERE template_identity IS NOT NULL;
