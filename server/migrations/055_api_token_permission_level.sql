-- Adds the four-tier permission model to api_tokens (054 already applied —
-- this is additive, per that migration's own comment that the eventual
-- permission column would arrive later).
--
-- TEXT + CHECK, not a native Postgres ENUM — matches this repo's existing
-- convention for every other status/role/mode column. Extending the
-- allowed set later is a one-line DROP/ADD CONSTRAINT (the same pattern
-- migration 039 used for drafts_status_check), not an ALTER TYPE ... ADD
-- VALUE, which has its own transaction/ordering quirks.
--
-- Default 'read_only' is not just the safest choice, it's literally
-- correct for every row that exists today — every token minted before
-- this migration could only ever reach the read-only tools that existed
-- at the time. No backfill UPDATE needed.
ALTER TABLE api_tokens
  ADD COLUMN IF NOT EXISTS permission_level TEXT NOT NULL DEFAULT 'read_only';

ALTER TABLE api_tokens DROP CONSTRAINT IF EXISTS api_tokens_permission_level_check;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_permission_level_check
  CHECK (permission_level IN ('read_only', 'ai_actions', 'automation', 'admin'));
