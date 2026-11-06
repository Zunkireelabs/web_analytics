// PostHog adapter — optional, per project.
//
// Why it exists alongside GA4 rather than instead of it: GA4 answers "how many came and from where", and answers it
// authoritatively because it is what Google itself measured. PostHog answers the question GA4 structurally cannot —
// where in a flow people stop, what one person actually did, whether they came back — because it keeps the raw event
// stream. A client who uses both is not duplicating; they are asking two different questions.
//
// Reads through PostHog's HogQL query API, which is the one surface that works identically on their US cloud, EU
// cloud and self-hosted instances. Nothing here is written to PostHog; the key only ever reads.
//
// A project with no connection returns null everywhere. That is a normal, complete state, not a degraded one.

import { hostGuard } from '../integrations/posthog-connect.js';

const FETCH_TIMEOUT_MS = 20000;

export function configured(credentials) {
  return !!(credentials?.projectId && credentials?.apiKey && credentials?.host);
}

/**
 * Run one HogQL query. Returns { ok, columns, rows } or { ok: false, reason, detail }.
 *
 * Errors are RETURNED, never thrown: a client's revoked key or a self-hosted instance that is down must mark the
 * connection and move on, not abort a daily job that is also serving every other project.
 */
export async function runQuery(credentials, hogql, { fetchImpl = fetch, lookup } = {}) {
  // A sign-in (OAuth) whose token could not be refreshed arrives here carrying the real reason (revoked, unreachable).
  // Report THAT, not "not connected": the person has to know to reconnect, and the job must mark this one connection.
  if (credentials?.authError) return { ok: false, reason: credentials.authError.reason, detail: credentials.authError.detail };
  if (!configured(credentials)) return { ok: false, reason: 'not_connected' };
  // The address is checked EVERY time it is used, not only when it was saved: it holds a credential that is about to be sent
  // to it, and what a name resolves to can change after the choice was made.
  const blocked = await hostGuard(credentials.host, lookup ? { lookup } : {});
  if (blocked) return blocked;
  const url = `${credentials.host}/api/projects/${encodeURIComponent(credentials.projectId)}/query/`;
  let res;
  try {
    res = await fetchImpl(url, {
      // Never follow a redirect: a validated address must not be able to bounce the credential somewhere unchecked.
      redirect: 'manual',
      method: 'POST',
      headers: {
        // A personal API key is a bearer credential. It is never logged, and never returned to a caller.
        Authorization: `Bearer ${credentials.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: err.message };
  }

  if (res.status === 401 || res.status === 403) {
    // Named specifically: a revoked or wrong-scope key is the most common real failure, and "unauthorized" is
    // something a person can act on, unlike a bare HTTP code.
    return { ok: false, reason: 'unauthorized', detail: `PostHog rejected the API key (HTTP ${res.status}). It may have been revoked, or it may lack project read access.` };
  }
  if (res.status === 404) {
    return { ok: false, reason: 'project_not_found', detail: `PostHog has no project ${credentials.projectId} on ${credentials.host}. Check the project ID, and that the host matches the region or self-hosted instance.` };
  }
  if (!res.ok) return { ok: false, reason: 'failed', detail: `PostHog answered with an error (status ${res.status}).` };

  let body = null;
  try { body = await res.json(); } catch { return { ok: false, reason: 'failed', detail: 'PostHog returned a response that was not JSON.' }; }
  return { ok: true, columns: body?.columns || [], rows: body?.results || [] };
}

/** Cheapest possible call that proves the key, the project and the host all work together. */
export async function verifyConnection(credentials, { fetchImpl = fetch } = {}) {
  const out = await runQuery(credentials, 'SELECT 1', { fetchImpl });
  if (!out.ok) return { ok: false, reason: out.reason, detail: out.detail };
  return { ok: true };
}

/**
 * One day of product metrics. Deliberately a small, fixed set: these are the numbers GA4 cannot give, and asking for
 * more would mean deciding on a client's behalf what their events mean.
 *
 * A metric PostHog did not return stays null rather than 0 — "we could not measure this" must not read as "none".
 */
export async function fetchPosthogForDate(credentials, date, { fetchImpl = fetch } = {}) {
  const out = await runQuery(credentials, `
    SELECT
      count() AS events,
      count(DISTINCT person_id) AS people,
      countIf(event = '$pageview') AS pageviews,
      count(DISTINCT $session_id) AS sessions
    FROM events
    WHERE toDate(timestamp) = toDate('${sqlDate(date)}')
  `, { fetchImpl });

  if (!out.ok) return out;
  const row = out.rows?.[0] || [];
  return {
    ok: true,
    date,
    totals: {
      events: numberOrNull(row[0]),
      people: numberOrNull(row[1]),
      pageviews: numberOrNull(row[2]),
      sessions: numberOrNull(row[3]),
    },
  };
}

// Events PostHog records automatically around every visit. If they were counted, "where people stopped" would be
// $pageleave on nearly every session — true of every site, and useless. Only a deliberate action or a page is a place
// someone can be said to have stopped.
const HOUSEKEEPING_EVENTS = ["$pageleave", "$autocapture", "$web_vitals", "$feature_flag_called", "$set", "$identify",
  "$groupidentify", "$exception", "$rageclick", "$dead_click", "$opt_in"];
const HOUSEKEEPING_SQL = HOUSEKEEPING_EVENTS.map((e) => `'${e}'`).join(', ');

// What a session's last meaningful step is called: a pageview is named by its path ("page: /pricing"), because
// "$pageview" alone says nothing about WHERE; a custom event keeps its own name ("signup_form_viewed").
const LAST_STEP_SQL = `argMax(if(event = '$pageview', concat('page: ', coalesce(properties.$pathname, '/')), event), timestamp)`;

/**
 * The top drop-off points for a day: the last meaningful step people reached before their session ended. This is the
 * PostHog-only insight — GA4 can say a page was the last one seen, but not which action in a flow people abandoned.
 */
export async function fetchDropOffs(credentials, date, { limit = 10, fetchImpl = fetch } = {}) {
  const out = await runQuery(credentials, `
    SELECT step, count() AS sessions_ending_here
    FROM (
      SELECT $session_id AS session, ${LAST_STEP_SQL} AS step
      FROM events
      WHERE toDate(timestamp) = toDate('${sqlDate(date)}') AND $session_id IS NOT NULL
        AND event NOT IN (${HOUSEKEEPING_SQL})
      GROUP BY session
    )
    GROUP BY step
    ORDER BY sessions_ending_here DESC
    LIMIT ${Math.min(Math.max(Number(limit) || 10, 1), 50)}
  `, { fetchImpl });

  if (!out.ok) return out;
  return {
    ok: true,
    date,
    dropOffs: (out.rows || []).map((r) => ({ event: r[0], sessionsEndingHere: numberOrNull(r[1]) })).filter((d) => d.event),
  };
}

// ── What visitors did (clicks and form steps) ───────────────────────────────

// A custom event keeps its own name, made readable: booking_form_started -> "Booking form started". Deterministic, so the
// same event is the same label on every day and the days add up.
export function humaniseEvent(raw) {
  const words = String(raw || '').replace(/^\$/, '').replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

// PostHog's autocapture records every click and form submit as the same "$autocapture" event; what was clicked is only in
// the element's text. A click on a button labelled "Book now" is an action worth naming; one with no text, or text long
// enough to be a whole block of the page, is not (and could hold anything), so it is left out rather than guessed at.
const MAX_CLICK_LABEL = 60;
const cleanText = (t) => String(t ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** One query row (event, kind, text, times) -> { label, raw, times } or null when it cannot be named honestly. */
export function actionFromRow(row) {
  const event = row?.[0];
  const times = numberOrNull(row?.[3]);
  if (!event || times == null || times <= 0) return null;
  if (event === '$autocapture') {
    const kind = String(row[1] || '');
    if (kind === 'submit') return { label: 'Submitted a form', raw: null, times };
    const text = cleanText(row[2]);
    if (kind !== 'click' || !text || text.length > MAX_CLICK_LABEL) return null;
    return { label: `Clicked \u201c${text}\u201d`, raw: null, times };
  }
  const label = humaniseEvent(event);
  return label ? { label, raw: String(event), times } : null;
}

// Page views are counted elsewhere (pages viewed), and the housekeeping events say nothing a person did on purpose.
const ACTION_EXCLUDED_SQL = [...HOUSEKEEPING_EVENTS.filter((e) => e !== '$autocapture'), '$pageview'].map((e) => `'${e}'`).join(', ');
const ACTION_KIND_SQL = `if(event = '$autocapture', toString(properties.$event_type), '')`;
const ACTION_TEXT_SQL = `if(event = '$autocapture', substring(trim(toString(properties.$el_text)), 1, 200), '')`;

// Merge rows that name the same action (two buttons both labelled "Book now") and keep the biggest few.
function topActionsFrom(rows, cap) {
  const merged = new Map();
  for (const row of rows) {
    const a = actionFromRow(row);
    if (!a) continue;
    const hit = merged.get(a.label);
    if (hit) hit.times += a.times; else merged.set(a.label, { ...a });
  }
  return [...merged.values()].sort((x, y) => y.times - x.times || x.label.localeCompare(y.label)).slice(0, cap);
}

/** The day's most-used clicks and form steps: the "What visitors did" card. Same return convention as fetchDropOffs. */
export async function fetchTopActions(credentials, date, { limit = 15, fetchImpl = fetch } = {}) {
  const out = await runQuery(credentials, `
    SELECT event, ${ACTION_KIND_SQL} AS kind, ${ACTION_TEXT_SQL} AS txt, count() AS times
    FROM events
    WHERE toDate(timestamp) = toDate('${sqlDate(date)}') AND event NOT IN (${ACTION_EXCLUDED_SQL})
    GROUP BY event, kind, txt
    ORDER BY times DESC
    LIMIT 500
  `, { fetchImpl });
  if (!out.ok) return out;
  return { ok: true, date, topActions: topActionsFrom(out.rows || [], Math.min(Math.max(Number(limit) || 15, 1), 50)) };
}

/**
 * Many days in two queries, for importing history when a project first connects. Per-day calls would be sixty
 * requests for a month and would trip PostHog's rate limits on exactly the moment someone is watching it work.
 *
 * Returns { ok, days: [{ date, totals, dropOffs }] }. A day with no events is simply absent — it is stored as
 * unmeasured rather than as a zero, because PostHog cannot tell "nobody came" from "tracking was not installed yet".
 */
export async function fetchPosthogRange(credentials, start, end, { perDayDropOffs = 10, perDayActions = 15, fetchImpl = fetch } = {}) {
  const from = sqlDate(start);
  const to = sqlDate(end);
  if (from > to) throw new Error(`Invalid range ${from} to ${to}.`);
  const spanDays = (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000;
  if (spanDays > 120) throw new Error('A PostHog import is limited to 120 days at a time.');

  const totals = await runQuery(credentials, `
    SELECT toString(toDate(timestamp)) AS d, count() AS events, count(DISTINCT person_id) AS people,
           countIf(event = '$pageview') AS pageviews, count(DISTINCT $session_id) AS sessions
    FROM events
    WHERE toDate(timestamp) >= toDate('${from}') AND toDate(timestamp) <= toDate('${to}')
    GROUP BY d ORDER BY d
  `, { fetchImpl });
  if (!totals.ok) return totals;

  // Drop-offs are the reason to connect, but a failure here must not lose the totals that already came back.
  const drops = await runQuery(credentials, `
    SELECT d, step, count() AS n
    FROM (
      SELECT toString(toDate(min(timestamp))) AS d, $session_id AS session, ${LAST_STEP_SQL} AS step
      FROM events
      WHERE toDate(timestamp) >= toDate('${from}') AND toDate(timestamp) <= toDate('${to}')
        AND $session_id IS NOT NULL AND event NOT IN (${HOUSEKEEPING_SQL})
      GROUP BY session
    )
    GROUP BY d, step
  `, { fetchImpl }).catch(() => ({ ok: false }));

  // Same rule for actions: a failure here must not lose the totals.
  //
  // The cap is PER DAY (a window over the day), never one global LIMIT: a global limit ordered by day cuts off the most
  // recent days of a busy site, which would then be stored as having no actions while still reporting them available.
  // The top 50 rows per day are kept (more than the 15 finally stored, because rows naming the same action are merged
  // afterwards); 120 days at most is 6,000 rows.
  const acts = await runQuery(credentials, `
    SELECT d, event, kind, txt, times
    FROM (
      SELECT d, event, kind, txt, times, row_number() OVER (PARTITION BY d ORDER BY times DESC) AS rn
      FROM (
        SELECT toString(toDate(timestamp)) AS d, event, ${ACTION_KIND_SQL} AS kind, ${ACTION_TEXT_SQL} AS txt, count() AS times
        FROM events
        WHERE toDate(timestamp) >= toDate('${from}') AND toDate(timestamp) <= toDate('${to}') AND event NOT IN (${ACTION_EXCLUDED_SQL})
        GROUP BY d, event, kind, txt
      )
    )
    WHERE rn <= 50
    ORDER BY d, times DESC
    LIMIT 10000
  `, { fetchImpl }).catch(() => ({ ok: false }));

  const byDay = new Map();
  for (const row of totals.rows || []) {
    const date = String(row[0]).slice(0, 10);
    byDay.set(date, {
      date,
      totals: { events: numberOrNull(row[1]), people: numberOrNull(row[2]), pageviews: numberOrNull(row[3]), sessions: numberOrNull(row[4]) },
      dropOffs: [],
      topActions: [],
    });
  }
  if (acts.ok) {
    const grouped = new Map();
    for (const row of acts.rows || []) {
      const date = String(row[0]).slice(0, 10);
      if (!byDay.has(date)) continue;
      if (!grouped.has(date)) grouped.set(date, []);
      grouped.get(date).push(row.slice(1));
    }
    for (const [date, rows] of grouped) byDay.get(date).topActions = topActionsFrom(rows, perDayActions);
  }
  if (drops.ok) {
    const grouped = new Map();
    for (const row of drops.rows || []) {
      const date = String(row[0]).slice(0, 10);
      if (!row[1] || !byDay.has(date)) continue;
      if (!grouped.has(date)) grouped.set(date, []);
      grouped.get(date).push({ event: row[1], sessionsEndingHere: numberOrNull(row[2]) });
    }
    for (const [date, list] of grouped) {
      byDay.get(date).dropOffs = list.sort((a, b) => (b.sessionsEndingHere ?? 0) - (a.sessionsEndingHere ?? 0)).slice(0, perDayDropOffs);
    }
  }
  return { ok: true, days: [...byDay.values()], dropOffsAvailable: drops.ok, actionsAvailable: acts.ok };
}

// The date is interpolated into HogQL, so it is validated to be exactly YYYY-MM-DD rather than trusted. Every caller
// is internal today, but a query string built from an unchecked value is the shape of a future injection.
function sqlDate(date) {
  const s = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Invalid date "${s}" — expected YYYY-MM-DD.`);
  return s;
}

function numberOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
