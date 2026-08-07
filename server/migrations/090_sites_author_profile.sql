-- The site's real, human-confirmed author/byline identity — Phase 2 of the
-- Quality Gate work (Phase 1: migration 089). Until now no generator could
-- honestly populate an Article/BlogPosting/NewsArticle schema's `author`
-- field or a visible on-page byline without fabricating a person, so
-- content-gap.js's GAP_TYPE_TO_GENERATOR keeps 'Missing author/expertise
-- signal' mapped to null on principle (see that file's comment) — this
-- column is what turns "unfabricatable" into "real," letting schema.js and
-- expand-content.js's author-byline focus draft the real thing instead of a
-- "[Author Name]" placeholder, and letting that GEO-signals finding
-- (geo-signals.js, generatorId: 'expand-content', already 'safe'-tier) get
-- fully auto-remediated by auto-remediation.js once it is.
--
-- Nullable/defaulted so every existing site works unchanged: NULL
-- author_name means "no profile configured yet," not "broken" — schema.js
-- and expand-content.js fall back to their existing placeholder-drafting
-- behavior exactly as before whenever it's null. require_visible_byline is
-- a separate policy switch (some sites want author schema only, not a
-- visible on-page byline block) — deliberately independent of whether a
-- name is configured, same as the other config booleans in this table.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS author_name TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS author_role TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS author_url TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS require_visible_byline BOOLEAN NOT NULL DEFAULT false;
