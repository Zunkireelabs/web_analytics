-- AI crawler analytics: which AI bots visit each project's website (server/ai-crawlers/).
--
-- Multi-tenant by construction: every table that holds a project's data has site_id as the FIRST column of its key and a
-- foreign key to sites with ON DELETE CASCADE, so one project's rows can never be read, merged or kept alive under another's,
-- and deleting a project deletes its crawler data with it. The project a batch belongs to is decided by the upload token
-- (ai_crawler_tokens), never by anything in the uploaded data.
--
-- What is stored is DAILY COUNTS only: day, bot, URL path (no query string), HTTP status, whether the visit was verified
-- against the vendor's published IP list, and how many hits. No raw log lines, no visitor addresses, no user agents.
-- Rows older than 13 months are deleted (server/store/ai-crawlers.js pruneCrawlerData).
--
-- Additive and idempotent, like every file here; no data statements.

CREATE TABLE IF NOT EXISTS ai_crawler_visits_daily (
  site_id      INTEGER  NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day          DATE     NOT NULL,                 -- UTC day
  bot_id       TEXT     NOT NULL,                 -- server/ai-crawlers/bots.js id, e.g. 'oai-searchbot'
  path         TEXT     NOT NULL CHECK (char_length(path) <= 200),   -- '(other)' once a day's distinct-path cap is reached
  status       SMALLINT NOT NULL CHECK (status BETWEEN 100 AND 599),
  -- verified: address inside the vendor's list | unverified: claims to be the bot but the address is not in the list |
  -- unchecked: could not be checked (vendor publishes no list, or the list could not be loaded)
  verification TEXT     NOT NULL CHECK (verification IN ('verified', 'unverified', 'unchecked')),
  hits         INTEGER  NOT NULL CHECK (hits > 0),
  PRIMARY KEY (site_id, day, bot_id, path, status, verification)
);

-- One row per uploaded batch (a hash of its content), so the same batch sent twice (a retry after a timeout) is counted once.
-- Kept for 14 days, long enough for any retry.
CREATE TABLE IF NOT EXISTS ai_crawler_batches (
  site_id     INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  batch_hash  TEXT        NOT NULL,
  visits      INTEGER     NOT NULL DEFAULT 0,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, batch_hash)
);
CREATE INDEX IF NOT EXISTS ai_crawler_batches_received_idx ON ai_crawler_batches (received_at);

-- Upload credentials for the log-shipping script. Deliberately NOT the MCP api_tokens table: a leaked shipping token can only
-- add crawler counts to its own project and can read nothing. Only a hash is stored; the raw token is shown once at creation.
CREATE TABLE IF NOT EXISTS ai_crawler_tokens (
  id           BIGSERIAL   PRIMARY KEY,
  site_id      INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  token_hash   TEXT        NOT NULL UNIQUE,
  token_prefix TEXT        NOT NULL,
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,                       -- every authenticated upload, even an empty one: the "script is alive" signal
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ai_crawler_tokens_site_idx ON ai_crawler_tokens (site_id);

-- The vendors' published IP lists, cached so a visit can be verified without fetching on every upload. Public vendor data,
-- shared by every project, so no site_id. cidrs is the last SUCCESSFUL fetch and is kept when a later fetch fails (a failed
-- refresh must never turn real crawlers into "unverified"); last_error says why the latest attempt failed.
CREATE TABLE IF NOT EXISTS ai_crawler_ip_lists (
  list_id         TEXT        PRIMARY KEY,
  cidrs           JSONB,
  creation_time   TEXT,
  fetched_at      TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT
);
