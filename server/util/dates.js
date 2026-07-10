// Timezone-aware date helpers. "Today" must be computed in the site's timezone
// so that "yesterday" lines up with how GSC/GA4 bucket days for the property.

// Returns YYYY-MM-DD for `now` in the given IANA timezone.
export function todayInTz(timezone, now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// Returns YYYY-MM-DD that is `days` before the timezone-local today.
export function daysAgoInTz(timezone, days, now = new Date()) {
  const ymd = todayInTz(timezone, now);
  const [y, m, d] = ymd.split('-').map(Number);
  // Build a UTC date from the local Y/M/D, subtract days, reformat. DST-safe at day granularity.
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
}

// The most recent fully-completed Mon–Sun week before today (in the given TZ).
// Returns { start, end } as YYYY-MM-DD (Monday .. Sunday).
export function previousWeek(timezone, now = new Date()) {
  const ymd = todayInTz(timezone, now);
  const [y, m, d] = ymd.split('-').map(Number);
  const today = new Date(Date.UTC(y, m - 1, d));
  // getUTCDay: 0=Sun..6=Sat. Days since this week's Monday:
  const dow = today.getUTCDay();
  const sinceMonday = (dow + 6) % 7; // Mon->0, Tue->1, ... Sun->6
  const thisMonday = new Date(today);
  thisMonday.setUTCDate(today.getUTCDate() - sinceMonday);
  const start = new Date(thisMonday);
  start.setUTCDate(thisMonday.getUTCDate() - 7); // previous Monday
  const end = new Date(thisMonday);
  end.setUTCDate(thisMonday.getUTCDate() - 1);   // previous Sunday
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// The most recent fully-completed calendar month before today (in the given TZ).
// Returns { year, month } (month is 1-12).
export function previousMonth(timezone, now = new Date()) {
  const ymd = todayInTz(timezone, now);
  const [y, m] = ymd.split('-').map(Number);
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

// The Mon–Sun week containing a given YYYY-MM-DD anchor date.
export function weekOf(anchorYmd) {
  const [y, m, d] = anchorYmd.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  const start = new Date(day);
  start.setUTCDate(day.getUTCDate() - sinceMonday);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// The equal-length period immediately before [start, end] (both YYYY-MM-DD,
// inclusive). E.g. priorPeriod('2026-07-01', '2026-07-07') (7 days) →
// { start: '2026-06-24', end: '2026-06-30' }. Used by agents to compare a
// caller-supplied range against "the same-length period right before it",
// mirroring previousWeek()'s recent-vs-prior pattern for arbitrary ranges.
export function priorPeriod(start, end) {
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  const days = Math.round((e - s) / 86400000) + 1;
  const priorEnd = new Date(s);
  priorEnd.setUTCDate(priorEnd.getUTCDate() - 1);
  const priorStart = new Date(priorEnd);
  priorStart.setUTCDate(priorStart.getUTCDate() - (days - 1));
  return { start: priorStart.toISOString().slice(0, 10), end: priorEnd.toISOString().slice(0, 10) };
}

// Inclusive list of YYYY-MM-DD strings from start..end (both YYYY-MM-DD).
export function dateRange(start, end) {
  const out = [];
  const cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cur <= last) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}
