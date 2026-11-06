-- PROPOSED, not applied. Only after page_key is backfilled AND every collision is folded (the plan shows 0 remaining).
-- CONCURRENTLY cannot run inside a transaction: run by hand with approval if the migration runner wraps files in one.
-- The existing recommendations_dedup_key (site_id, page, recommendation_type) stays until a full week passes with no collisions.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS recommendations_open_page_key
  ON recommendations (site_id, page_key, recommendation_type)
  WHERE status = 'open' AND page_key IS NOT NULL;
