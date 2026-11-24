-- The Claude Code worker: a queue of AI writing requests that a program on a person's laptop answers (server/lib/claude-worker-provider.js,
-- server/routes/claude-worker.js, tools/claude-code-worker/). The server asks, the worker writes the text, the server does everything else
-- (its own checks, the repo writes and the pull request): the worker never touches a repository or GitHub.
--
-- llm_requests holds the prompts a generator sent, i.e. page content of clients, so rows are short-lived: store/llm-requests.js purges answered
-- or failed rows after 7 days. A request that is not answered before expires_at is marked 'expired' and the caller is told the AI provider was
-- unavailable (never that the generator failed).
-- Additive and idempotent; no data statements.
CREATE TABLE IF NOT EXISTS llm_requests (
  id            BIGSERIAL PRIMARY KEY,
  site_id       INTEGER,
  generator_id  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'expired')),
  system_text   TEXT NOT NULL,
  user_text     TEXT NOT NULL,
  options       JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_text TEXT,
  error         TEXT,
  worker_id     TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_requests_open ON llm_requests (status, id) WHERE status IN ('pending', 'claimed');

-- Which workers are connected right now: a worker reports in every few seconds, and "online" means it did so within the last minute and a half.
CREATE TABLE IF NOT EXISTS llm_workers (
  worker_id    TEXT PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  info         JSONB NOT NULL DEFAULT '{}'::jsonb
);
