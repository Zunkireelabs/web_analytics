-- Records WHY a draft's target file/record was chosen, at push time —
-- page-resolution.js's resolvePageSource() output, so a reviewer sees "this
-- edits src/_data/glossary.js's multi-tenant-saas record (one of 20 pages
-- rendered by the shared glossary-term.njk), affecting 1 URL" instead of a
-- bare file diff with no indication of what else shares that file.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS target_provenance JSONB;
