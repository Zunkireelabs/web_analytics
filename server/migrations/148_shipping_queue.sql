-- THE SHARED AUTONOMOUS SHIPPING QUEUE.
--
-- Every autonomous producer — Analytics remediation, the Data Analyst's
-- content-gap lane, the Design Agent, learned-repair's cross-client
-- interception, the whole-site content repair — used to reach production its
-- own way. Two of them (learned-repair, content-repair) opened their own pull
-- requests directly, which meant the "one build, one commit, one PR" model
-- was true only of the lane that happened to implement it, and the daily
-- ceiling only bounded the lane that happened to be counted.
--
-- This table is the single place work waits between being DECIDED and being
-- SHIPPED. A producer enqueues an intent during the day; a preparation pass
-- turns that intent into a real generated, validated draft; the 07:00
-- shipping run selects from what is already prepared, commits it once and
-- opens one PR. Nothing reaches a tenant's repository except through here
-- (the sole documented exception is code-self-repair, which repairs THIS
-- platform's own repository and is not a tenant-facing generator at all).
--
-- WHY A TABLE AND NOT JUST `drafts`. A draft exists only once generation has
-- already happened and succeeded. The queue has to hold work BEFORE that —
-- the intent, its evidence, its dedupe identity and its lane — so that a
-- crash, a deploy, an LLM outage or a GitHub outage between "we decided to
-- fix this" and "the fix is in a PR" leaves a row that says exactly how far
-- the work got and what is safe to redo. Without it, "recover without
-- redrafting or duplicating work" has nothing durable to recover FROM.
CREATE TABLE IF NOT EXISTS shipping_queue (
  id             BIGSERIAL PRIMARY KEY,
  site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,

  -- Which autonomous producer put this here. Matches drafts.source, so the
  -- daily ceiling counts the queue and the drafts table the same way.
  source         TEXT NOT NULL,
  -- 'analytics' | 'analyst'. Stamped by the producer at enqueue time, never
  -- re-inferred later from whether the page happens to be declining — the
  -- two lane totals have to stay separately observable to mean anything.
  lane           TEXT NOT NULL DEFAULT 'analytics',

  -- What to build. `kind` distinguishes the normal draft-producing path from
  -- producers that carry their own file edits (content-repair), which the
  -- shipping run commits onto the same batch branch rather than drafting.
  kind           TEXT NOT NULL DEFAULT 'draft',
  generator_id   TEXT,
  recommendation_id BIGINT,
  finding_id     TEXT,
  params         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Ranking evidence captured at enqueue time so the 07:00 selection does not
  -- have to re-derive it (and so a deferred item keeps its score history).
  score          NUMERIC,

  -- state machine:
  --   queued    — intent recorded, nothing generated yet
  --   preparing — a preparation pass has claimed it (claimed_at set)
  --   prepared  — a real draft exists and passed its validation gates
  --   shipping   — claimed by a shipping batch (batch_id set)
  --   shipped   — the batch's PR is confirmed open for this item
  --   failed    — terminal for this attempt; re-enqueueable tomorrow
  --   superseded — the same work arrived by another route
  state          TEXT NOT NULL DEFAULT 'queued',
  draft_id       BIGINT,
  -- Repository paths this item will write, known once prepared. The 07:00
  -- run uses these for conflict resolution: two items writing the same file
  -- in one batch is the one dependency conflict this pipeline can actually
  -- detect and resolve, by shipping the higher-scored one and re-queueing
  -- the other for the next day rather than letting the second silently
  -- regenerate the file from content the first already changed.
  file_paths     TEXT[] NOT NULL DEFAULT '{}',

  attempts       INT NOT NULL DEFAULT 0,
  last_error     TEXT,
  claimed_at     TIMESTAMPTZ,
  claimed_by     TEXT,
  batch_id       TEXT,
  prepared_at    TIMESTAMPTZ,
  shipped_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Stable identity for "this same piece of work", independent of which
  -- producer noticed it or how many times a cron pass re-noticed it. The
  -- partial unique index below is what makes enqueue idempotent: a producer
  -- may enqueue the same intent every hour all day and still create exactly
  -- one row, so a restart mid-preparation can never fan out into duplicates.
  dedupe_key     TEXT NOT NULL
);

-- Idempotent enqueue, enforced by the database rather than by every caller
-- remembering to check first. Scoped to the ACTIVE states only: once an item
-- has shipped or failed, tomorrow's genuinely-new detection of the same
-- problem is allowed to enqueue again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipping_queue_active_dedupe
  ON shipping_queue (site_id, dedupe_key)
  WHERE state IN ('queued', 'preparing', 'prepared', 'shipping');

CREATE INDEX IF NOT EXISTS idx_shipping_queue_site_state ON shipping_queue (site_id, state);
-- Backs the daily-spend count, which is per site and per calendar day.
CREATE INDEX IF NOT EXISTS idx_shipping_queue_shipped_at ON shipping_queue (site_id, shipped_at);
-- Backs the stale-claim sweep (a worker that died mid-preparation).
CREATE INDEX IF NOT EXISTS idx_shipping_queue_claimed_at ON shipping_queue (claimed_at)
  WHERE state IN ('preparing', 'shipping');
