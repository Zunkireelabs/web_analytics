-- 249: LOST-UPDATE PROTECTION FOR sites.url_file_map + DEDICATED DESIGN-REVIEW STORAGE.
--
-- Root cause being fixed. About twenty code paths (and a dozen operator scripts) update
-- sites.url_file_map by spreading a snapshot they read earlier and writing the WHOLE column
-- back. Two writers working from the same snapshot silently erase each other's change.
--
-- 1. Every url_file_map carries a revision in the JSON itself ("_rev"). Because every writer
--    builds its new value from the row it read, the revision it read travels with its write.
--    A BEFORE UPDATE trigger refuses a write whose _rev is not the row's current _rev
--    (SQLSTATE 40001, message 'stale url_file_map write'), then stamps _rev + 1.
--    No writer — new code, legacy code or a hand-run script — can silently lose an update.
-- 2. The previous version is kept (bounded history) so that
--      a. updateSiteRepoConfig can recover a refused write by a three-way merge
--         (base = the version the caller read, theirs = current row, ours = the caller's), and
--      b. a bad write can be rolled back.
-- 3. Design review data that is written on every validation (evidence, page results,
--    proposals, group history) moves into dedicated tables instead of rewriting the whole
--    url_file_map JSON per validation.
--
-- Additive and idempotent. Existing rows get _rev 0; no other value changes.

-- ── 1. revision + stale-write guard ────────────────────────────────────────
UPDATE sites SET url_file_map = jsonb_set(url_file_map, '{_rev}', '0'::jsonb, true)
 WHERE url_file_map IS NOT NULL AND NOT (url_file_map ? '_rev');

CREATE TABLE IF NOT EXISTS url_file_map_versions (
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  rev         BIGINT  NOT NULL,
  data        JSONB   NOT NULL,
  replaced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, rev)
);
ALTER TABLE url_file_map_versions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION guard_url_file_map_write() RETURNS trigger AS $$
DECLARE
  old_rev BIGINT := COALESCE((OLD.url_file_map->>'_rev')::bigint, 0);
  new_rev BIGINT := (NEW.url_file_map->>'_rev')::bigint;
BEGIN
  IF NEW.url_file_map IS NOT DISTINCT FROM OLD.url_file_map THEN
    RETURN NEW;
  END IF;
  IF new_rev IS NULL OR new_rev <> old_rev THEN
    RAISE EXCEPTION 'stale url_file_map write for site % (written from revision %, current revision %)', OLD.id, new_rev, old_rev
      USING ERRCODE = '40001', DETAIL = json_build_object('siteId', OLD.id, 'baseRev', new_rev, 'currentRev', old_rev)::text;
  END IF;
  INSERT INTO url_file_map_versions (site_id, rev, data) VALUES (OLD.id, old_rev, OLD.url_file_map)
    ON CONFLICT (site_id, rev) DO UPDATE SET data = EXCLUDED.data, replaced_at = now();
  DELETE FROM url_file_map_versions WHERE site_id = OLD.id AND rev < old_rev - 20;
  NEW.url_file_map := jsonb_set(NEW.url_file_map, '{_rev}', to_jsonb(old_rev + 1), true);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sites_url_file_map_guard ON sites;
CREATE TRIGGER sites_url_file_map_guard
  BEFORE UPDATE OF url_file_map ON sites
  FOR EACH ROW EXECUTE FUNCTION guard_url_file_map_write();

-- New rows start at revision 0.
CREATE OR REPLACE FUNCTION init_url_file_map_rev() RETURNS trigger AS $$
BEGIN
  IF NEW.url_file_map IS NOT NULL AND NOT (NEW.url_file_map ? '_rev') THEN
    NEW.url_file_map := jsonb_set(NEW.url_file_map, '{_rev}', '0'::jsonb, true);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS sites_url_file_map_init ON sites;
CREATE TRIGGER sites_url_file_map_init BEFORE INSERT ON sites FOR EACH ROW EXECUTE FUNCTION init_url_file_map_rev();

-- ── 2. dedicated design-review storage ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS design_validation_evidence (
  id         BIGSERIAL PRIMARY KEY,
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,              -- 'validation' | 'integrity' | 'visual' | ...
  page_path  TEXT,
  status     TEXT,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS design_validation_evidence_site_time ON design_validation_evidence (site_id, created_at DESC);
ALTER TABLE design_validation_evidence ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS design_page_results (
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_path  TEXT NOT NULL,
  result     JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, page_path)
);
ALTER TABLE design_page_results ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS design_proposals (
  id            TEXT PRIMARY KEY,
  site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,           -- 'join' | 'new-group' | 'replace-sample' | 'add-sample' | 'split-group' | 'page-gone' | 'new-page-pattern'
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | superseded | rolled-back
  page_path     TEXT,
  group_id      TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- capture, signals, reason, diff …
  base_revision INTEGER,
  seen          INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  decided_by    TEXT,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS design_proposals_site_status ON design_proposals (site_id, status, created_at);
ALTER TABLE design_proposals ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS design_group_history (
  id          BIGSERIAL PRIMARY KEY,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL,
  action      TEXT NOT NULL,             -- approve | reject | rollback
  proposal_id TEXT,
  actor       TEXT NOT NULL,
  note        TEXT,
  before      JSONB,                     -- snapshot of what the action replaced
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS design_group_history_site ON design_group_history (site_id, revision DESC);
ALTER TABLE design_group_history ENABLE ROW LEVEL SECURITY;
