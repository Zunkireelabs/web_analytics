-- Which agent's finding a verification row is re-checking — needed because
-- generator_id alone is ambiguous (e.g. 'faq' is produced by opportunity,
-- content-gap, AND ai-visibility) and the correct deterministic recheck
-- function differs per source (recommendationsFor for opportunity,
-- contentGapsFor for content-gap — see server/agents/lib/fix-verification.js).
ALTER TABLE fix_verifications ADD COLUMN IF NOT EXISTS source TEXT;
