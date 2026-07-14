-- Every status transition on a watchlist item — manual (user clicked
-- Start/Complete/Dismiss) or sync-driven (a closed item's underlying
-- finding reappeared with a material change) — so the UI can show *when*
-- and *why* an item moved, not just its current status. This is what makes
-- a sync-driven reopen distinguishable from a brand-new item instead of
-- silently looking identical to one (see agents/lib/watchlist.js).
CREATE TABLE IF NOT EXISTS watchlist_item_history (
  id                 SERIAL PRIMARY KEY,
  watchlist_item_id  INT NOT NULL REFERENCES watchlist_items(id) ON DELETE CASCADE,
  from_status        TEXT,
  to_status          TEXT NOT NULL,
  reason             TEXT,
  changed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_watchlist_history_item ON watchlist_item_history (watchlist_item_id, changed_at DESC);
