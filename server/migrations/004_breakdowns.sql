-- GA4 breakdowns by dimension (device, country) per day — mirrors ga4_channels.
-- GSC device/country reuse the existing gsc_breakdown table via new dim_type values.
CREATE TABLE IF NOT EXISTS ga4_breakdown (
  site_id   INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date      DATE NOT NULL,
  dim_type  TEXT NOT NULL,            -- 'device' | 'country'
  dim_value TEXT NOT NULL,
  sessions  INT,
  users     INT,
  PRIMARY KEY (site_id, date, dim_type, dim_value)
);

CREATE INDEX IF NOT EXISTS idx_ga4_breakdown_lookup ON ga4_breakdown (site_id, dim_type, date);
