-- ONE ROW PER PROJECT PER WORKING DAY: the record that every client's day ends with, whatever happened.
--
-- Why it exists (2026-11-25): six projects went through four worker passes and one PR came out. Nothing recorded, per project, "this is
-- where today ended and why": a project that was never reached (window closed), one with nothing eligible, one whose validated work sat
-- behind a failed PR all looked the same: no row. A project must not be able to disappear from a day.
--
-- cycle_date is the working day in the WORKER's time zone (Nepal), because the 5 PM deadline is a Nepal clock, not the server's.
-- status:
--   open        the day has started for this project; passes are still adding to it
--   delivered   a pull request was opened today for this project's validated work
--   preserved   validated work exists (a pushed branch / stored draft) but no PR could be opened; `blocker` and `recovery` say why and how
--   no-work     nothing was eligible. Recorded as a result, never hidden: `blocker` says why (nothing detected, all held, ...)
--   incomplete  eligible work remained when the day closed (window closed, rate limit, worker offline); `blocker` and `recovery` say what
--   unreached   the day closed before this project's turn came (the project was never started)
-- Never read by the shipping path itself. Written by the passes and by the 17:00 closer (lib/delivery-cycle.js).
--
-- Additive and idempotent, like every file here; no data statements.

CREATE TABLE IF NOT EXISTS delivery_cycles (
  id           BIGSERIAL PRIMARY KEY,
  site_id      INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  cycle_date   DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  passes       INTEGER NOT NULL DEFAULT 0,
  attempted    INTEGER NOT NULL DEFAULT 0,
  shipped      INTEGER NOT NULL DEFAULT 0,
  blocked      INTEGER NOT NULL DEFAULT 0,
  skipped      INTEGER NOT NULL DEFAULT 0,
  branch_name  TEXT,
  head_sha     TEXT,
  pr_url       TEXT,
  blocker      TEXT,
  recovery     TEXT,
  stages       JSONB NOT NULL DEFAULT '{}'::jsonb,
  opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_pass_at TIMESTAMPTZ,
  closed_at    TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_cycles_status_check CHECK (status IN ('open', 'delivered', 'preserved', 'no-work', 'incomplete', 'unreached')),
  CONSTRAINT delivery_cycles_site_day_unique UNIQUE (site_id, cycle_date)
);

CREATE INDEX IF NOT EXISTS delivery_cycles_day_idx ON delivery_cycles (cycle_date, status);
