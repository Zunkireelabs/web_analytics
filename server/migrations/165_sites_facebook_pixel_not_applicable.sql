-- Per-site opt-out for the "missing Meta/Facebook Pixel" trust-compliance
-- finding (server/agents/trust-compliance.js's TRACKER_CHECKS). That check
-- fires for every site with no Pixel detected on the homepage, on the
-- assumption every tenant runs Facebook/Instagram ads — real for most, not
-- universal. Chayce Properties (site 8864) confirmed 2026-09-18 they run no
-- Facebook/Instagram ad campaigns at all, so there is no real ID to ever
-- supply; without this flag the finding (and its placeholder-blocked
-- analytics-install draft) would keep resurfacing every detection pass
-- forever with no way to genuinely resolve it, same "real business fact,
-- not a bug" shape as facebook_pixel_id itself.
--
-- Same "default-on, per-site escape hatch" shape as allow_agency_credit
-- (161) — every tenant is assumed to want the check until they say
-- otherwise. GA4's equivalent check has no such flag: every real business
-- needs basic traffic analytics, so there is no legitimate "not applicable"
-- case to opt out of the way there genuinely is for one specific ad
-- platform's pixel.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS facebook_pixel_not_applicable BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN sites.facebook_pixel_not_applicable IS
  'True when this tenant confirmed they run no Facebook/Instagram ad campaigns, so the missing-Pixel trust-compliance finding and its analytics-install draft should never be generated. Default false (checked, like every other tenant) until a tenant explicitly opts out.';
