-- ONE ROW PER ITEM THE PIPELINE TOUCHED, PER DAY: what happened to each recommendation / draft inside a delivery cycle (268).
--
-- recommendation_attempts already records every attempt's failure class and retry policy; what it cannot say is "which item belongs to
-- which day's delivery, what state is it in now, and what is its stored content". This does, without a second copy of the content:
-- content_draft_id points at the drafts row, which keeps the generated content even after the draft is abandoned (abandoning a draft
-- never deletes it; it only lets the finding be drafted again). So a held or blocked item is a ledger row pointing at preserved content,
-- not a loss.
--
-- state:  selected -> generated -> validated -> shipped      (the normal path)
--         blocked      held by a gate or a failure; blocked_kind / blocked_reason / retry_policy say which and whether trying again can help
--         refused      the generator declined (nothing safe to write); same columns
--         skipped      not started this day (window closed, budget, paced); skip_reason says which
-- retry_policy mirrors lib/attempt-classification.js RETRY_POLICY (retry | needs_human | item_defect | never | already_resolved) and is
-- copied here at write time so the day's record stays readable if the classifier's rules later change.
--
-- Additive and idempotent, like every file here; no data statements.

CREATE TABLE IF NOT EXISTS delivery_items (
  id                BIGSERIAL PRIMARY KEY,
  cycle_id          BIGINT NOT NULL REFERENCES delivery_cycles(id) ON DELETE CASCADE,
  site_id           INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  recommendation_id INTEGER,
  finding_id        TEXT,
  draft_id          INTEGER,
  content_draft_id  INTEGER,
  generator_id      TEXT,
  page              TEXT,
  state             TEXT NOT NULL DEFAULT 'selected',
  blocked_kind      TEXT,
  blocked_reason    TEXT,
  retry_policy      TEXT,
  skip_reason       TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  history           JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_items_state_check CHECK (state IN ('selected', 'generated', 'validated', 'shipped', 'blocked', 'refused', 'skipped'))
);

-- One row per recommendation per day; a recommendation retried the same day updates its row (attempts + history) instead of adding rows.
CREATE UNIQUE INDEX IF NOT EXISTS delivery_items_cycle_rec_unique ON delivery_items (cycle_id, recommendation_id) WHERE recommendation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS delivery_items_site_state_idx ON delivery_items (site_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS delivery_items_draft_idx ON delivery_items (draft_id) WHERE draft_id IS NOT NULL;
