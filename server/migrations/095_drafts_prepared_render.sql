-- Precomputed, pre-validated render output for net-new-content drafts
-- (landing-page/blog-outline/direct-answer/translation/cookie-policy/
-- privacy-policy/terms-of-service — frontend.js's resolveTargetAndBody),
-- computed once at generateDraft time (design/template resolution +
-- rendering-gate validation already done before this row is written) so
-- approval never has to recompute or re-derive anything — it just writes
-- these exact bytes. NULL for a draft generated before this migration, or
-- for a marker-merge action type (backend.js) whose live-file splice must
-- still be computed fresh at apply time against whatever the target page
-- currently looks like — see newpage-render.js/frontend.js and backend.js's
-- own module comments for why these two families genuinely differ here.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS rendered_body TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS target_file_path TEXT;
