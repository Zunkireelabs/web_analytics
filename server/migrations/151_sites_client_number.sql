-- client_number is a small, sequential, human-facing identifier (1, 2, 3...)
-- assigned in onboarding order — what a person means when they say "site 2".
-- sites.id (the real primary key) is never sequential or human-meaningful:
-- it's a SERIAL that also gets consumed by test fixtures and anything else
-- that ever inserted a row, so a real client can land on an id like 8862.
-- Confused during a 2026-09-09 debugging session where "site 2" in
-- conversation didn't correspond to any real sites.id at all.
--
-- client_number is nullable and NOT tied to sites.id's own sequence: test
-- fixtures (server/**/*.test.js insert directly into `sites` with an
-- explicit column list) simply never set it and stay NULL forever, which is
-- correct — they were never real clients and must not consume a number.

ALTER TABLE sites ADD COLUMN IF NOT EXISTS client_number INTEGER UNIQUE;

COMMENT ON COLUMN sites.client_number IS
  'Small sequential onboarding-order number (1, 2, 3...) shown to humans in logs/dashboards. NULL for test-fixture rows. Never used in queries or FKs — sites.id remains the real primary key everywhere.';

-- Backfill the two real, onboarded sites known at the time of this migration.
UPDATE sites SET client_number = 1 WHERE id = 1 AND client_number IS NULL;
UPDATE sites SET client_number = 2 WHERE id = 8862 AND client_number IS NULL;

-- A real Postgres sequence, independent of sites_id_seq, so createClientSite()
-- can assign the next number atomically (no read-then-write race between two
-- concurrent onboardings). Kept in sync with whatever's actually in the table
-- rather than hardcoded to 2, so this migration stays safe to re-run after
-- more real clients have been onboarded.
CREATE SEQUENCE IF NOT EXISTS sites_client_number_seq;
SELECT setval('sites_client_number_seq', (SELECT COALESCE(MAX(client_number), 0) FROM sites));
