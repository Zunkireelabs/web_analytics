import { saveNotification } from '../../store/notifications.js';

export const id = 'in-app';

export async function deliver(siteId, events) {
  for (const e of events) {
    await saveNotification(siteId, { type: e.type, severity: e.severity, title: e.title, body: e.body, findingIds: e.findingIds || [] })
      .catch((err) => console.error(`[notifications] in-app delivery failed for "${e.title}":`, err.message));
  }
}
