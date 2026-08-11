-- Links a draft (and the fix-verification row scheduled for it) back to the
-- agent_fix_memory row it reused/adapted, if any — this is what lets
-- fix-verification.js's automatic outcome check (verified-fixed /
-- still-present) record success/failure against the SPECIFIC memory that was
-- reused, not just "some fix happened for this generator". NULL means the
-- draft was generated from scratch (no prior memory matched), which is a
-- normal, common case, not an error.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS memory_ref_id INTEGER REFERENCES agent_fix_memory(id);
ALTER TABLE fix_verifications ADD COLUMN IF NOT EXISTS memory_ref_id INTEGER REFERENCES agent_fix_memory(id);
