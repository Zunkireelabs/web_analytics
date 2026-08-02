import { getSiteById } from '../../store/read.js';
import { sendNotificationEmail } from '../../report/email.js';

export const id = 'email';

export async function deliver(siteId, events) {
  const site = await getSiteById(siteId);
  if (!site) return;
  await sendNotificationEmail(site, events).catch((err) =>
    console.error(`[notifications] email delivery failed for site ${siteId}:`, err.message)
  );
}
