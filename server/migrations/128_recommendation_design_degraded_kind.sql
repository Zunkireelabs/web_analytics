-- The Action Center was showing the amber "Blocked — setup needed / Can't be
-- drafted yet" lock badge on recommendations whose ONLY blocker was a failed
-- Design Context analysis run. That message (implementers/lib/
-- design-agent-status.js's FAILED state) explicitly says drafting continues
-- against the default fallback template and the analysis retries
-- automatically — it is diagnostic, not something a human needs to act on —
-- but classifyBlockedKind (store/recommendations.js) had nowhere to put that
-- distinction except the 'our-config' bucket (migration 110), whose UI
-- framing was written for genuinely actionable gaps like a missing
-- url_file_map entry. 'awaiting-derivation' was deliberately NOT reused here
-- (see the pre-existing test asserting a failed run does NOT read as
-- awaiting-derivation) — a repeated failure is worth a human being able to
-- see, unlike a routine queued/running state, it just isn't a reason to
-- block drafting. 'design-degraded' gives it its own honest bucket: visible,
-- but explicitly "drafting with the default look while this is retried,"
-- never "blocked."
ALTER TABLE recommendations DROP CONSTRAINT IF EXISTS recommendations_blocked_kind_check;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_blocked_kind_check
  CHECK (blocked_kind IS NULL OR blocked_kind IN ('our-config', 'awaiting-derivation', 'site-fact', 'design-degraded'));
