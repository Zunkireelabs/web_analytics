-- Daily website analytics schema
-- Designed for one site now, multiple sites later (site_id foreign keys).
-- All ingest writes use INSERT ... ON CONFLICT DO UPDATE so re-runs never duplicate.

CREATE TABLE IF NOT EXISTS sites (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  gsc_property    TEXT NOT NULL,        -- 'sc-domain:example.com' or 'https://example.com/'
  ga4_property_id TEXT NOT NULL,        -- numeric GA4 property id
  timezone        TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (gsc_property, ga4_property_id)
);

-- One row per site per day: overall GSC totals
CREATE TABLE IF NOT EXISTS gsc_daily (
  site_id     INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  clicks      INT,
  impressions INT,
  ctr         NUMERIC(7,5),
  position    NUMERIC(6,2),
  PRIMARY KEY (site_id, date)
);

-- Top queries & pages per day (dimension breakdown)
CREATE TABLE IF NOT EXISTS gsc_breakdown (
  site_id     INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  dim_type    TEXT NOT NULL,            -- 'query' | 'page'
  dim_value   TEXT NOT NULL,
  clicks      INT,
  impressions INT,
  ctr         NUMERIC(7,5),
  position    NUMERIC(6,2),
  PRIMARY KEY (site_id, date, dim_type, dim_value)
);

-- One row per site per day: GA4 totals
CREATE TABLE IF NOT EXISTS ga4_daily (
  site_id             INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date                DATE NOT NULL,
  users               INT,
  new_users           INT,
  sessions            INT,
  engaged_sessions    INT,
  avg_engagement_time NUMERIC(10,2),    -- seconds (averageSessionDuration)
  conversions         INT,
  PRIMARY KEY (site_id, date)
);

-- Traffic by default channel group per day
CREATE TABLE IF NOT EXISTS ga4_channels (
  site_id  INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date     DATE NOT NULL,
  channel  TEXT NOT NULL,               -- Organic Search, Direct, Referral, ...
  sessions INT,
  users    INT,
  PRIMARY KEY (site_id, date, channel)
);

-- AI-written daily narrative + email status
CREATE TABLE IF NOT EXISTS daily_reports (
  site_id    INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date       DATE NOT NULL,
  narrative  TEXT,
  emailed_at TIMESTAMPTZ,
  PRIMARY KEY (site_id, date)
);

CREATE INDEX IF NOT EXISTS idx_gsc_breakdown_lookup ON gsc_breakdown (site_id, dim_type, date);
CREATE INDEX IF NOT EXISTS idx_ga4_channels_lookup ON ga4_channels (site_id, date);
