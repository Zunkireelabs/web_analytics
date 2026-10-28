-- Google Business Profile, asked right after Google (Search Console + Analytics) in the New project flow.
-- Optional by design: a software product or an online-only business has none, so nothing here is required
-- for a project to be "ready". Additive and nullable.
--   linked          the business has one; gbp_url is the Google Maps / business link it gave us
--   none            the business should have one and doesn't yet (the flow showed the create-one guide)
--   not_applicable  not a local business, so the step does not apply
ALTER TABLE sites ADD COLUMN IF NOT EXISTS gbp_status TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS gbp_url TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS gbp_updated_at TIMESTAMPTZ;
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_gbp_status_check;
ALTER TABLE sites ADD CONSTRAINT sites_gbp_status_check CHECK (gbp_status IS NULL OR gbp_status IN ('linked', 'none', 'not_applicable'));
