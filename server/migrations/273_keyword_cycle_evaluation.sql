-- 15-day keyword cycle: what a shipped keyword actually earned in the 14 days after it went live, and what the day-15 evaluation decided.
-- Additive: nullable columns / defaults only, no rewrite of existing rows. Written only from Search Console rows (gsc_query_page); never estimated.
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS clicks_14d        INT;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS position_14d      NUMERIC(6,2);
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS evaluation        TEXT;          -- retain | improve | replace
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS evaluation_round  INT NOT NULL DEFAULT 0;
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS evaluated_at      TIMESTAMPTZ;
