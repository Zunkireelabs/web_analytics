-- Staff sign-off that a site's design profile was actually looked at before
-- any autonomous fix is allowed to ship styled markup — the design-integrity
-- gate that closes the incident where a wrong-role design profile
-- (typography.body actually being the site's eyebrow style) was projected
-- into templates, verified only against class EXISTENCE (never role), and
-- shipped with no human checkpoint anywhere in that chain.
--
-- Nullable, no backfill: every existing site correctly reads as unreviewed.
-- That is the honest and safe default — a site that predates this migration
-- has genuinely never had a human confirm its design profile, and treating
-- silence as approval would be exactly the failure this exists to stop.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS design_review_at TIMESTAMPTZ;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS design_review_by INT REFERENCES users(id) ON DELETE SET NULL;

-- sha256 over ONLY what a reviewer actually approved — the five projected
-- component templates plus each typography field's role-verification input
-- (see designReviewFingerprint, implementers/lib/design-drift.js) — never
-- the whole stored profile. profile.evidence.notes and
-- profile.site.pagesAnalyzed change on every weekly rescan without changing
-- a single thing that ships; fingerprinting the whole profile would
-- invalidate a valid review on that noise and train staff to re-approve
-- without reading, which is worse than no gate at all.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS design_review_fingerprint TEXT;
