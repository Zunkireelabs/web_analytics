-- Query+page pairs per day, so a specific query's clicks can be traced to the exact
-- landing page. gsc_breakdown stores 'query' and 'page' as independent single-dimension
-- rows with no shared key, so it can't answer "which page did this query land on".
CREATE TABLE IF NOT EXISTS gsc_query_page (
  site_id     INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  query       TEXT NOT NULL,
  page        TEXT NOT NULL,
  clicks      INT,
  impressions INT,
  ctr         NUMERIC(7,5),
  position    NUMERIC(6,2),
  PRIMARY KEY (site_id, date, query, page)
);

CREATE INDEX IF NOT EXISTS idx_gsc_query_page_lookup ON gsc_query_page (site_id, query, date);
