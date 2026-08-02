// Documentation-only contract — no runtime code. The AI emits
// NotificationEvents; delivery channels subscribe to them. Detection
// (server/notifications/detect.js) and delivery (server/notifications/
// channels/) are deliberately separate files so a new channel (email,
// Slack, Teams, mobile push) never touches detection logic, and a change to
// what counts as "notification-worthy" never touches delivery — same
// separation as the competitor-providers adapter pattern
// (ingest/competitor-providers/types.js).

/**
 * @typedef {Object} NotificationEvent
 * @property {string} type            'critical-issue' | 'critical-issues-group' | 'opportunity' |
 *                                     'health-drop' | 'competitor-change' | 'predictive-risk'
 * @property {'high'|'medium'} severity
 * @property {string} title           short, e.g. "3 new critical issues found"
 * @property {string} body            one sentence, real evidence, no fabrication
 * @property {string[]} [findingIds]  real Finding.id references this event is about
 */

/**
 * @typedef {Object} NotificationChannel
 * @property {string} id
 * @property {(siteId: number, events: NotificationEvent[]) => Promise<void>} deliver
 *              Must not throw on a single event's failure — log and continue,
 *              same "one failure doesn't sink the batch" rule every other
 *              fan-out in this codebase follows.
 */
export {};
