-- PROPOSED, not applied. What each project's own site proves about its URLs (lib/page-key/site-policy.js):
--   { "www": "bare|www|distinct|unknown", "scheme": "https|distinct|unknown", "trailingSlash": "add|strip|distinct|unknown",
--     "verifiedAt": "...", "evidence": [ { "dimension", "basis": "redirect|canonical", "finalA", "finalB" } ] }
-- The canonical key folds a variant only along a dimension whose value is not distinct/unknown, and always INTO the form the site
-- redirects to. Sites disagree (Zunkiree and Chayce add a trailing slash, Admizz strips it), so this cannot be one global rule.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS url_policy JSONB;
