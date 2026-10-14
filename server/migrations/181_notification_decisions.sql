-- Why every alert was or wasn't sent (server/notifications/alert-gate.js).
--
-- Four of the seven event types in detect.js carry no cooldown at all
-- (critical-issue, critical-issues-group, opportunity, competitor-change), and
-- 'predictive-risk' — pushed from the Python nightly pipeline through the MCP
-- push_predictive_alert tool — is never checked by hasRecentNotification at
-- all, so it re-fires EVERY NIGHT for the whole life of an unresolved
-- forecast_risk insight. The only brake today is hasNotificationToday, which
-- guards the email channel alone; the in-app bell is uncapped.
--
-- Two reasons this is a table and not just a stricter read of `notifications`:
--
--   1. Cooldowns need an identity finer than `type`. `notifications` stores
--      finding_ids as an array with no index for "have I already said THIS",
--      so a per-finding/per-page key has nowhere to live. event_key is that
--      identity (type + the finding/page/insight it is about).
--   2. A suppression gate that keeps no record of what it suppressed is
--      untunable, and "why wasn't I told about X" becomes unanswerable. A
--      suppressed event writes a row here and nowhere else, so this is the
--      only evidence it ever existed.
--
-- decision: 'delivered' | 'suppressed' | 'would-suppress'. The third is the
-- log-only rollout mode (ALERT_GATE_ENABLED unset): the gate records what it
-- WOULD have done while every event still goes out, so a week of rows can be
-- read before enforcement is switched on. Only 'delivered' rows satisfy a
-- cooldown — a suppressed event must not start another cooldown of its own,
-- or one suppression would silently extend into a permanent mute.
--
-- Deliberately NOT a deduplication authority: this table records decisions.
-- Work deduplication lives in work_claims (180) and the recommendations
-- partial unique index (077b).
--
-- Schema only, additive and idempotent — this directory re-runs every file on
-- every deploy.
CREATE TABLE IF NOT EXISTS notification_decisions (
  id BIGSERIAL PRIMARY KEY,
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_key TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  severity TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE notification_decisions DROP CONSTRAINT IF EXISTS notification_decisions_decision_check;
ALTER TABLE notification_decisions ADD CONSTRAINT notification_decisions_decision_check
  CHECK (decision IN ('delivered', 'suppressed', 'would-suppress'));

-- The cooldown lookup: newest decision for one (site, type, key). Ordered
-- DESC on created_at so the "has this been delivered within N days" probe is
-- an index-only backwards scan rather than a sort.
CREATE INDEX IF NOT EXISTS notification_decisions_cooldown_idx
  ON notification_decisions (site_id, event_type, event_key, created_at DESC);

-- For reading a week of rollout evidence per site ("what would have been
-- suppressed, and why").
CREATE INDEX IF NOT EXISTS notification_decisions_audit_idx
  ON notification_decisions (site_id, created_at DESC);
