-- Real record of what happened when this platform tried to notify Search
-- Console after a draft's merge (Part 3 of the multi-tenant refactor) —
-- lives on the draft itself since that's already the natural audit unit
-- Action Center reviews, alongside stage_merge_sha/stage_merge_url which
-- already document "what happened at merge". Nullable/purely additive.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS gsc_notification JSONB;
