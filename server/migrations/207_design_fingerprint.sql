-- Cheap weekly "did the site's look change?" signal. A hash of the live site's
-- stylesheets is compared week to week; a change queues a full design re-capture
-- instead of waiting for the monthly one. Additive and nullable.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS design_fingerprint text;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS design_fingerprint_at timestamptz;
