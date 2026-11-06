import { getPosthogCredentials, upsertPosthogDay, recordPosthogStatus, isPermanentPosthogFailure } from '../store/project-posthog.js';
import { fetchPosthogRange } from '../ingest/posthog.js';

// Imports the recent past when a project first connects PostHog.
//
// Without this, connecting on a Tuesday means the report shows nothing for a week: the daily job only ever fetches
// yesterday. Someone who has just pasted a key and sees an empty card concludes it did not work. History already
// exists in their PostHog, so it is fetched once, in two queries, and the card has something real to show straight away.
//
// Never throws into the caller: it runs in the background after a connect, where an exception would be an unhandled
// rejection that nobody is positioned to read. Every outcome is returned and logged instead.

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

export async function backfillPosthog(siteId, { days = DEFAULT_DAYS, now = new Date(), deps = {} } = {}) {
  const getCredentials = deps.getPosthogCredentials || getPosthogCredentials;
  const fetchRange = deps.fetchPosthogRange || fetchPosthogRange;
  const save = deps.upsertPosthogDay || upsertPosthogDay;
  const status = deps.recordPosthogStatus || recordPosthogStatus;

  const span = Math.min(Math.max(Number(days) || DEFAULT_DAYS, 1), MAX_DAYS);
  try {
    const credentials = await getCredentials(siteId);
    if (!credentials) return { ok: false, reason: 'not_connected', imported: 0 };

    // Ends YESTERDAY, never today: today is a partial day and would be stored as if it were final.
    const end = new Date(now); end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end); start.setUTCDate(start.getUTCDate() - (span - 1));
    const range = await fetchRange(credentials, ymd(start), ymd(end));

    if (!range.ok) {
      // A key that works for SELECT 1 but not for the events table (read scope missing) shows up here, which is
      // exactly where it should be reported — on the connection, in words, not as a silently empty card.
      // Only a failure about the CONNECTION marks it. A timeout or a PostHog outage leaves the status alone, so the nightly job
      // still tries tomorrow instead of being switched off by one bad moment.
      if (isPermanentPosthogFailure(range.reason)) await status(siteId, false, range.detail || range.reason);
      return { ok: false, reason: range.reason, detail: range.detail || null, imported: 0 };
    }

    let imported = 0;
    for (const day of range.days) {
      await save(siteId, { date: day.date, totals: day.totals, dropOffs: day.dropOffs, topActions: day.topActions || [] });
      imported += 1;
    }
    await status(siteId, true);
    return { ok: true, imported, from: ymd(start), to: ymd(end), dropOffsAvailable: range.dropOffsAvailable !== false, actionsAvailable: range.actionsAvailable !== false };
  } catch (err) {
    console.error(`[posthog-backfill] site ${siteId}:`, err.message);
    return { ok: false, reason: 'error', detail: err.message, imported: 0 };
  }
}

const ymd = (d) => d.toISOString().slice(0, 10);
