-- learned-repair.js's cross-client memory reference (agent_fix_memory.id)
-- needs a home distinct from `params`: it is metadata ABOUT the queued
-- item's provenance (which proven repair this borrows), not an input to the
-- generator itself, and the shipping run needs it back at ship time to
-- record recordFixOutcome success/failure against the right memory row —
-- the same bookkeeping learned-repair.js always did, just now happening at
-- shipping time instead of at enqueue time.
ALTER TABLE shipping_queue ADD COLUMN IF NOT EXISTS memory_ref_id BIGINT;
