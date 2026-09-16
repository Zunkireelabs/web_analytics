import * as inApp from './in-app.js';
import * as email from './email.js';
import { getSiteById } from '../../store/read.js';
import { hasNotificationToday } from '../../store/notifications.js';

// Every registered delivery channel. Adding Slack/Teams/push later is a
// one-line addition here plus one new channel file (see ./types.js) —
// nothing in detect.js or the callers of deliverToAllChannels changes.
const CHANNELS = [inApp, email];

// The email-spam guard lives here, decided ONCE before any channel below
// runs, rather than inside email.js's own deliver(). The channels run
// concurrently (Promise.all) and in-app's deliver() writes the very
// `notifications` row hasNotificationToday reads — deciding after kicking
// both off would race: a fast in-app write could make the email check see
// its own batch's row and wrongly skip a legitimate first send of the day.
// See store/notifications.js's hasNotificationToday for why this exists at
// all (runDailyAgentAnalysisForSite is reachable from three places in a
// single day, and most notification event types carry no cooldown).
export async function deliverToAllChannels(siteId, events) {
  if (!events.length) return;
  const site = await getSiteById(siteId).catch(() => null);
  const canEmail = site ? !(await hasNotificationToday(siteId, site.timezone || 'UTC').catch(() => false)) : true;
  await Promise.all(CHANNELS.map((c) =>
    c.deliver(siteId, events, { canEmail }).catch((err) => console.error(`[notifications] channel "${c.id}" failed:`, err.message))
  ));
}
