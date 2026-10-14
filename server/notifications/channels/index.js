import * as inApp from './in-app.js';
import * as email from './email.js';
import { getSiteById } from '../../store/read.js';
import { hasNotificationToday } from '../../store/notifications.js';
import { gateEvents } from '../alert-gate.js';

// Every registered delivery channel. Adding Slack/Teams/push later is a
// one-line addition here plus one new channel file (see ./types.js) —
// nothing in detect.js or the callers of deliverToAllChannels changes.
const CHANNELS = [inApp, email];

// Per-site per-day ceiling on the in-app bell.
//
// hasNotificationToday has always capped EMAIL at one batch per day, with the
// bell deliberately left uncapped so the dashboard showed every real event.
// That reasoning holds for a handful of events and breaks for a flood: with
// four event types carrying no cooldown and a pipeline reachable three times
// a day, the bell was the one surface that could fill with repeats. The
// alert-gate's keyed cooldowns remove most of that; this is the backstop for
// a genuinely large single batch.
//
// Collapse rather than drop: everything past the ceiling becomes ONE grouped
// row, so no event is ever silently discarded from the bell — the same
// "group where appropriate" idiom detect.js already uses for
// critical-issues-group.
const MAX_IN_APP_PER_BATCH = 3;

export function collapseForInApp(events, max = MAX_IN_APP_PER_BATCH) {
  if (events.length <= max) return events;
  const kept = events.slice(0, max);
  const rest = events.slice(max);
  const findingIds = rest.flatMap((e) => e.findingIds || []).filter(Boolean);
  // Highest severity in the remainder, so collapsing can never quietly
  // downgrade a high-severity event into a medium-severity summary.
  const severity = rest.some((e) => e.severity === 'high') ? 'high' : 'medium';
  return [...kept, {
    type: 'critical-issues-group',
    severity,
    title: `${rest.length} more update${rest.length === 1 ? '' : 's'}`,
    body: rest.slice(0, 3).map((e) => e.title).join(' · '),
    findingIds,
  }];
}

// The email-spam guard lives here, decided ONCE before any channel below
// runs, rather than inside email.js's own deliver(). The channels run
// concurrently (Promise.all) and in-app's deliver() writes the very
// `notifications` row hasNotificationToday reads — deciding after kicking
// both off would race: a fast in-app write could make the email check see
// its own batch's row and wrongly skip a legitimate first send of the day.
// See store/notifications.js's hasNotificationToday for why this exists at
// all (runDailyAgentAnalysisForSite is reachable from three places in a
// single day, and most notification event types carry no cooldown).
// The alert gate runs FIRST, before the email guard and before any channel:
// an event nobody needs should not consume the one email of the day, and
// deciding after kicking the channels off would be too late to withhold
// anything. In log-only mode (ALERT_GATE_ENABLED unset) it returns every
// event unchanged, so this call is behaviourally inert until enabled.
export async function deliverToAllChannels(siteId, events) {
  if (!events.length) return;
  const { deliver: gated } = await gateEvents(siteId, events)
    .catch((err) => {
      // A broken gate must not silence real alerts. Fail open.
      console.error('[notifications] alert gate failed, delivering ungated:', err.message);
      return { deliver: events };
    });
  if (!gated.length) return;
  const site = await getSiteById(siteId).catch(() => null);
  const canEmail = site ? !(await hasNotificationToday(siteId, site.timezone || 'UTC').catch(() => false)) : true;
  await Promise.all(CHANNELS.map((c) =>
    c.deliver(siteId, c.id === 'in-app' ? collapseForInApp(gated) : gated, { canEmail })
      .catch((err) => console.error(`[notifications] channel "${c.id}" failed:`, err.message))
  ));
}
