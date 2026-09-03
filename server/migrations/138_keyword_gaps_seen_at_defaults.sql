-- 129_keyword_gaps_observation_tracking.sql made first_seen_at/last_seen_at
-- NOT NULL but never gave them a DEFAULT (every sibling timestamp column —
-- page_inventory.first_seen_at, growth_query_discovery.first_seen_at/
-- last_seen_at, recommendations.last_seen_at — uses DEFAULT now()). Neither
-- INSERT INTO keyword_gaps call site (saveKeywordGaps' fresh-row branch,
-- createUserKeywordGap) sets these columns explicitly, so every insert that
-- isn't an ON CONFLICT UPDATE has been failing with a not-null violation
-- since 129 shipped — confirmed live via the Analyst page's "Grow for a
-- keyword" box (errorId 37086eea, dev-analytics).
ALTER TABLE keyword_gaps ALTER COLUMN first_seen_at SET DEFAULT now();
ALTER TABLE keyword_gaps ALTER COLUMN last_seen_at SET DEFAULT now();
