import { createHash } from 'node:crypto';
import { hasRecentDeliveredDecision, recordNotificationDecisions } from '../store/notification-decisions.js';
import { getDraftedFindingIds } from '../store/drafts.js';

// The one place that decides whether a real event is worth interrupting
// someone over. Sits in front of every delivery channel
// (channels/index.js's deliverToAllChannels), so a channel added later —
// including a chat bot, of which this repo currently has none — inherits the
// policy without touching detection or delivery.
//
// Two things it does NOT do:
//
//   * It never invents or re-ranks events. detect.js decides what happened;
//     this decides who needs telling. Severity is passed through untouched.
//   * It never removes information. A suppressed event is still a real
//     finding, still in the Action Center, still in the findings diff. Only
//     the interrupt is withheld, and the reason is recorded in
//     notification_decisions (181) so "why wasn't I told" has an answer.

// Per-type cooldown, keyed by event identity rather than by type alone, so
// "already told them about THIS" and "already told them about something of
// this kind" stop being the same question.
//
// detect.js already enforces its own 7-day windows for health-drop,
// citation-rate-drop and citation-gap-widened before it ever emits them; the
// windows here are the same length, so those three are unchanged in practice
// and the gate is their backstop rather than a second, different policy.
//
// The four types that had NO cooldown of any kind are the reason this file
// exists: critical-issue, critical-issues-group, opportunity and
// competitor-change could all re-fire on every run of a pipeline that is
// reachable three times a day.
export const COOLDOWN_DAYS = {
  'critical-issue': 3,
  'critical-issues-group': 3,
  'opportunity': 7,
  'competitor-change': 7,
  'health-drop': 7,
  'citation-rate-drop': 7,
  'citation-gap-widened': 7,
  // The nightly repeat, and the single noisiest source in the system: the
  // Python pipeline (app/alerts/deliver.py -> MCP push_predictive_alert)
  // re-pushes this every night for as long as a forecast_risk insight stays
  // unresolved, and hasRecentNotification was never consulted for it at all.
  // 14 days per insight identity, not per type — a genuinely different
  // forecast still gets through tomorrow.
  'predictive-risk': 14,
  // Unchanged from ship-window.js's existing 1-day cooldown.
  'ship-stall': 1,
  // One per blocked-design episode (see design-blocked.js, which also holds
  // its own cooldown so this works with the gate off).
  'design-blocked': 7,
};

// Operational alarms: these report that the SYSTEM is failing, not that the
// site has a finding worth acting on. They are exempt from the actionability
// check below, and deliberately so.
//
// agent_fix_memory carries a recorded lesson for exactly this trap —
// "implement alerts for critical thresholds ... ensuring the alerting
// mechanism is in place for any silent failures" — which came out of a real
// bug where a background job fell short of its threshold and nobody heard
// about it. Suppressing a ship-stall because "nothing shipped, so there is no
// draft to point at" would re-create that silence precisely when the alarm
// matters most: the absence of work is the alarm. They still get a cooldown.
export const OPERATIONAL_TYPES = new Set(['ship-stall', 'internal-error-digest', 'design-blocked']);

// Enforcement is opt-in per deployment. Unset (the default) runs the gate in
// log-only mode: it computes and records every decision as 'would-suppress'
// while still delivering everything, so a week of real rows can be read
// before anything is actually withheld. Same convention as
// AGENTIC_ORCHESTRATION_ENABLED / DECISION_ENGINE_GAP_ANNOTATIONS.
export function isGateEnforcing(env = process.env) {
  return env.ALERT_GATE_ENABLED === 'true';
}

// A stable identity for "this exact alert".
//
// findingIds is the real identity whenever detection has one: the same
// finding re-detected tomorrow produces the same key, while a different
// finding of the same type produces a different one. Order-insensitive,
// because the diff's ordering is not guaranteed stable across runs and a
// reordered group is not a new group.
//
// Metric-level events (health-drop, citation-rate-drop, citation-gap-widened)
// carry no findingIds at all — for them the site plus the type IS the
// identity, since there is only ever one health score to drop.
//
// Anything else with neither (a future event type, or a predictive alert
// pushed in from Python) falls back to a hash of its own text. That is weaker
// than a real id — a reworded body counts as a new alert — but it degrades
// toward alerting rather than toward silence, which is the correct direction
// for a guess.
export function eventKeyFor(event) {
  const ids = (event.findingIds || []).filter(Boolean);
  if (ids.length) return [...ids].map(String).sort().join(',');
  if (event.insightId) return `insight:${event.insightId}`;
  if (!event.title && !event.body) return event.type;
  const text = `${event.title || ''}|${event.body || ''}`;
  return `text:${createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
}

// True when every finding this event is about already has a live draft — the
// agent has already decided how to fix it, so an alert saying "this is
// broken" is telling someone about work that is underway.
//
// Requires at least one finding id: an event with none has nothing to check,
// and must not be suppressed on the strength of an empty set being
// vacuously "all drafted".
export function isAlreadyBeingHandled(event, draftedFindingIds) {
  const ids = (event.findingIds || []).filter(Boolean);
  if (!ids.length) return false;
  return ids.every((id) => draftedFindingIds.has(id));
}

// Decides a whole batch at once and returns what should actually be
// delivered, plus every suppression with its reason.
//
// Dependencies are injected (same pattern as createDecisionEngine and the
// design agent's composeExpandLayoutFn) so the decision logic is unit
// testable without a database, which is what lets the cooldown table and the
// actionability rules be covered by real tests rather than only in production.
export async function gateEvents(siteId, events, deps = {}) {
  const {
    hasRecentDelivered = hasRecentDeliveredDecision,
    loadDraftedFindingIds = getDraftedFindingIds,
    recordDecisions = recordNotificationDecisions,
    enforcing = isGateEnforcing(),
  } = deps;

  if (!events.length) return { deliver: [], suppressed: [], enforcing };

  // One query for the whole batch rather than one per event. Failing soft
  // here is deliberate: if we cannot tell what is already drafted, the
  // honest default is to alert, not to go quiet on a guess.
  let draftedFindingIds = new Set();
  if (events.some((e) => !OPERATIONAL_TYPES.has(e.type))) {
    draftedFindingIds = await loadDraftedFindingIds(siteId).catch(() => new Set());
  }

  const deliver = [];
  const suppressed = [];
  const decisions = [];
  // Within-batch collapse: detect.js can emit two events that resolve to the
  // same identity (a group and its own members, after a partial prior run),
  // and a cooldown read cannot see a sibling decided microseconds earlier in
  // the same batch.
  const seenKeys = new Set();

  for (const event of events) {
    const eventKey = eventKeyFor(event);
    const base = { eventType: event.type, eventKey, severity: event.severity ?? null };
    let reason = null;

    if (seenKeys.has(eventKey)) {
      reason = 'duplicate-in-batch';
    } else {
      const cooldownDays = COOLDOWN_DAYS[event.type];
      if (cooldownDays) {
        const recentlyDelivered = await hasRecentDelivered(siteId, event.type, eventKey, cooldownDays)
          .catch(() => false);
        if (recentlyDelivered) reason = `cooldown:${cooldownDays}d`;
      }
      if (!reason && !OPERATIONAL_TYPES.has(event.type) && isAlreadyBeingHandled(event, draftedFindingIds)) {
        reason = 'already-drafted';
      }
    }

    seenKeys.add(eventKey);

    if (!reason) {
      deliver.push(event);
      decisions.push({ ...base, decision: 'delivered' });
      continue;
    }

    // Log-only mode: record the judgement, deliver anyway. The event also
    // counts as delivered for cooldown purposes in this mode, because it
    // genuinely was — recording it as suppressed would make the cooldown
    // read lie about what the user actually received.
    if (!enforcing) {
      deliver.push(event);
      decisions.push({ ...base, decision: 'would-suppress', reason });
      decisions.push({ ...base, decision: 'delivered', reason: 'log-only-mode' });
      continue;
    }

    suppressed.push({ event, reason });
    decisions.push({ ...base, decision: 'suppressed', reason });
  }

  // Never let bookkeeping sink a real alert: the same "one failure doesn't
  // sink the batch" rule every other fan-out in this codebase follows.
  await recordDecisions(siteId, decisions).catch((err) => {
    console.error('[alert-gate] recording decisions failed:', err.message);
  });

  return { deliver, suppressed, enforcing };
}
