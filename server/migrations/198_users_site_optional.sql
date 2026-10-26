-- A login no longer has to belong to a site.
--
-- Until now every user row carried a home site (users.site_id NOT NULL), because
-- accounts were only ever created together with a client's site. Self-serve
-- sign-up separates the two: staff approve a sign-up request into a LOGIN only,
-- and the person then creates their own workspace and projects from inside the
-- app. Between approval and their first project there is genuinely no site to
-- point at, and inventing a placeholder site would show up as a project nobody
-- created.
--
-- NULL users.site_id therefore means "signed up, hasn't made a project yet". It
-- is filled in (the first project they create becomes their home) by the
-- workspace routes. Every existing row keeps its value; the foreign key and the
-- index stay; nothing is backfilled.
--
-- Relaxing a NOT NULL is additive for live data and idempotent: re-running it on
-- a column that is already nullable is a no-op.

ALTER TABLE users ALTER COLUMN site_id DROP NOT NULL;
