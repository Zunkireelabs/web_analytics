-- One-time cleanup for a real state bug hit on the dev DB: migration 044's
-- CREATE TABLE IF NOT EXISTS (before this migration set's fix) recreated
-- commoncrawl_referring_domains/commoncrawl_domain_summary as empty
-- duplicates on a second full migration re-run, after migration 045 had
-- already renamed the originals to commoncrawl_backlink_domains/
-- commoncrawl_backlink_summary. Confirmed empty (0 rows) before writing this
-- — nothing reads or writes these old names anymore (server/store/
-- commoncrawl-backlinks.js only ever queries the new names).
DROP TABLE IF EXISTS commoncrawl_referring_domains;
DROP TABLE IF EXISTS commoncrawl_domain_summary;
