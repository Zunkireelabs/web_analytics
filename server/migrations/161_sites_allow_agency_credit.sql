-- Per-site opt-out for the Zunkireelabs agency-credit backlink (deterministic
-- "Website & content growth by Zunkireelabs" line added to generated blog
-- posts, see server/agents/lib/zunkireelabs-growth-policy.js's
-- agencyCreditLine()). Defaults to true: this is the standing policy for
-- every client tenant (client_number != 1) unless a specific client asks to
-- be excluded — same "default-on, per-site escape hatch" shape as
-- require_visible_byline (090) being the opposite default for a different
-- reason. Zunkireelabs's own site (client_number = 1) never credits itself
-- regardless of this column — that exclusion is a client_number check, not
-- this one, same as attributionNote()/agencyCreditLine() already do for the
-- contextual in-body mention.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS allow_agency_credit BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN sites.allow_agency_credit IS
  'Whether generated blog posts may include the deterministic Zunkireelabs agency-credit backlink line. Default true for every client tenant; set false to opt a specific client out. Irrelevant for client_number = 1 (Zunkireelabs never credits itself).';
