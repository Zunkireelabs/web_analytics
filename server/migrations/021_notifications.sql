-- In-app notifications — the first (and today, only) subscriber to the
-- channel-agnostic notification event system (server/notifications/). Real
-- events only: emitted from actual fresh findings/health deltas after the
-- daily agent run, never synthesized to make the feed look busier.
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  site_id     INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  type        TEXT NOT NULL, -- 'critical-issue' | 'critical-issues-group' | 'opportunity' | 'health-drop' | 'competitor-change'
  severity    TEXT NOT NULL CHECK (severity IN ('high', 'medium')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  finding_ids TEXT[] NOT NULL DEFAULT '{}',
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_site_unread ON notifications (site_id, read_at, created_at DESC);
