-- Topic-cluster support for keyword_gaps (multi-tenant SEO growth spec's
-- "build topic cluster" action, previously missing entirely — clustering
-- only ever existed for ALREADY-RANKING queries, via keyword_clusters).
-- Both columns are nullable: most gaps stay standalone (topic_cluster NULL),
-- same "this only overrides, never replaces, the default single-topic
-- behavior" convention as site_seo_policy (155).
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS topic_cluster TEXT;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS cluster_role TEXT;

ALTER TABLE keyword_gaps DROP CONSTRAINT IF EXISTS keyword_gaps_cluster_role_check;
ALTER TABLE keyword_gaps ADD CONSTRAINT keyword_gaps_cluster_role_check
  CHECK (cluster_role IS NULL OR cluster_role IN ('pillar', 'supporting'));

-- A cluster is only meaningful grouped by (site_id, topic_cluster) — this
-- index is what qualifyAndShipContentGaps/createActionCenterRecommendationForGap
-- use to find a gap's siblings before shipping it.
CREATE INDEX IF NOT EXISTS idx_keyword_gaps_topic_cluster ON keyword_gaps (site_id, topic_cluster) WHERE topic_cluster IS NOT NULL;
