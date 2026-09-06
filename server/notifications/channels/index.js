import * as inApp from './in-app.js';
import * as email from './email.js';

// Every registered delivery channel. Adding Slack/Teams/push later is a
// one-line addition here plus one new channel file (see ./types.js) —
// nothing in detect.js or the callers of deliverToAllChannels changes.
const CHANNELS = [inApp, email];

export async function deliverToAllChannels(siteId, events) {
  if (!events.length) return;
  await Promise.all(CHANNELS.map((c) =>
    c.deliver(siteId, events).catch((err) => console.error(`[notifications] channel "${c.id}" failed:`, err.message))
  ));
}
