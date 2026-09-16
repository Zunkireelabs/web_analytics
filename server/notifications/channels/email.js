import { getSiteById } from '../../store/read.js';
import { sendNotificationEmail } from '../../report/email.js';

export const id = 'email';

// `canEmail` is decided ONCE by deliverToAllChannels, before any channel
// (including in-app, which writes the very row that decision would
// otherwise read) does anything for this batch — see that module's comment
// on why the check can't safely live in here. Defaults to true so a direct
// call (a test, or any future caller that doesn't pass it) keeps today's
// behavior instead of silently going mute.
export async function deliver(siteId, events, { canEmail = true } = {}) {
  if (!canEmail) {
    console.log(`[notifications] site ${siteId}: already sent a notification email today — skipping (in-app still recorded).`);
    return;
  }
  const site = await getSiteById(siteId);
  if (!site) return;
  await sendNotificationEmail(site, events).catch((err) =>
    console.error(`[notifications] email delivery failed for site ${siteId}:`, err.message)
  );
}
