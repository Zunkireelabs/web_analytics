-- Authority Score can now come from either DataForSEO (the full 5-signal
-- score) or, as a fallback when DataForSEO isn't configured, Common Crawl's
-- referring-domain count alone (a single-signal, coarser estimate — see
-- server/agents/authority.js). data_source distinguishes which one produced
-- a given snapshot, so a caller comparing scores across a source switch can
-- detect it instead of misreading a data-source change as a real swing in
-- authority. Existing rows all came from DataForSEO (the only source until
-- now), hence the default.
ALTER TABLE authority_snapshots ADD COLUMN IF NOT EXISTS data_source TEXT NOT NULL DEFAULT 'dataforseo';
