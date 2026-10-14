// Coverage guard for recent-vs-prior comparisons. job.js hands agents windows
// that end at 'today', but GSC lags ~3 days and a GA4 property only has rows
// from the day it was connected — so the 'recent' window can be shorter than
// the 'prior' one and the prior window can be nearly (or entirely) empty.
// Comparing those as if they were whole produced "Nepal grew from 31 to 599
// sessions" / "grew from 0 to 47" claims that were only a data-start artifact.
//
// Same philosophy as analyst-freshness.js / decline-detection.js: know the
// source's lag, require real volume, and ABSTAIN rather than assert when the
// inputs can't support the claim. Pure functions only — the one DB read this
// needs (which dates have rows) is store/read.js's getBreakdownDataDates, so
// everything here is unit-testable with a plain Set of dates.

// Same value/reason as analyst-freshness.js / decline-detection.js / job.js —
// duplicated rather than imported (see the note in decline-detection.js).
export const GSC_LAG_DAYS = 3;

// Both windows must have rows on at least this share of their days. 90%, not
// 100%: a single quiet day or one missing backfill must not silence the agent,
// but a prior window that is 3 days of 28 (site 8862's GA4) must.
export const MIN_WINDOW_COVERAGE = 0.9;

const DAY_MS = 86400000;
const toMs = (ymd) => Date.parse(`${ymd}T00:00:00Z`);
const toYmd = (ms) => new Date(ms).toISOString().slice(0, 10);
const todayYmd = (today) => (today instanceof Date ? today.toISOString().slice(0, 10) : (today || new Date().toISOString().slice(0, 10)));

export function windowDays(win) {
  return Math.max(0, Math.round((toMs(win.end) - toMs(win.start)) / DAY_MS) + 1);
}

// How many of the window's days have at least one row.
export function windowCoverage(win, dates) {
  const set = dates instanceof Set ? dates : new Set(dates || []);
  const total = windowDays(win);
  if (total === 0) return { days: 0, covered: 0, ratio: 0 };
  let covered = 0;
  for (let t = toMs(win.start); t <= toMs(win.end); t += DAY_MS) if (set.has(toYmd(t))) covered++;
  return { days: total, covered, ratio: covered / total };
}

/**
 * Decides whether a recent-vs-prior comparison is supportable, and returns the
 * windows the comparison should actually use.
 *
 *   lagDays — the source's reporting lag (GSC_LAG_DAYS for gsc_*, 0 for GA4).
 *             The recent window is clipped to (today - lagDays); the prior
 *             window loses the same number of trailing days so the two stay
 *             the same length.
 *   dates   — every date the source has rows for across both windows (an
 *             iterable of YYYY-MM-DD), or null when that is unknown.
 *
 * @returns {{ ok: boolean, recent, prior, coverage: {recent, prior}, reason: ?string }}
 */
export function assessWindows(recent, prior, dates, { lagDays = 0, today, minCoverage = MIN_WINDOW_COVERAGE } = {}) {
  const fail = (reason, extra = {}) => ({ ok: false, recent, prior, coverage: null, reason, ...extra });
  if (dates == null) return fail('data coverage could not be determined');

  const cutoff = toYmd(toMs(todayYmd(today)) - lagDays * DAY_MS);
  const recentEnd = recent.end > cutoff ? cutoff : recent.end;
  const clippedRecent = { start: recent.start, end: recentEnd };
  const trim = windowDays(recent) - windowDays(clippedRecent);
  if (windowDays(clippedRecent) === 0) return fail('the recent window ends before the source\'s data is final');
  const clippedPrior = trim > 0 ? { start: prior.start, end: toYmd(toMs(prior.end) - trim * DAY_MS) } : prior;
  if (windowDays(clippedPrior) === 0) return fail('the prior window is empty after aligning to the recent window');

  const coverage = { recent: windowCoverage(clippedRecent, dates), prior: windowCoverage(clippedPrior, dates) };
  const base = { recent: clippedRecent, prior: clippedPrior, coverage };
  if (coverage.prior.ratio < minCoverage) {
    return { ok: false, ...base, reason: `the prior window has data on only ${coverage.prior.covered} of ${coverage.prior.days} days` };
  }
  if (coverage.recent.ratio < minCoverage) {
    return { ok: false, ...base, reason: `the recent window has data on only ${coverage.recent.covered} of ${coverage.recent.days} days` };
  }
  return { ok: true, ...base, reason: null };
}

// GA4 reports these for sessions it could not attribute — never a real market
// or device, so they cannot be a "growing market".
const UNATTRIBUTED = new Set(['(not set)', '(other)', 'not set', 'other', '(none)']);
export const isUnattributedDim = (v) => v == null || UNATTRIBUTED.has(String(v).trim().toLowerCase());

/**
 * Per-dimension SHARE of the total in each window, not just absolute deltas.
 * During a whole-site surge (site 1's total sessions rose ~10x) every row's
 * absolute delta is large and the biggest row "wins" as a market/device shift
 * even though nothing changed about the mix; share change is invariant to the
 * site-wide move. Unattributed values are dropped from rows AND totals.
 *
 * @param recentRows/priorRows  [{ dim_value, sessions }] — the FULL breakdown
 *   for the window (not a top-N delta slice), so the totals are real.
 * @returns rows sorted by |shareDelta| desc: { key, recent, prior, delta,
 *   recentShare, priorShare, shareDelta } (shares in percent, shareDelta in
 *   percentage points).
 */
export function computeShareShifts(recentRows, priorRows, { value = 'sessions' } = {}) {
  const clean = (rows) => new Map((rows || [])
    .filter((r) => !isUnattributedDim(r.dim_value))
    .map((r) => [r.dim_value, Number(r[value]) || 0]));
  const r = clean(recentRows);
  const p = clean(priorRows);
  const rTotal = [...r.values()].reduce((s, v) => s + v, 0);
  const pTotal = [...p.values()].reduce((s, v) => s + v, 0);
  if (rTotal <= 0 || pTotal <= 0) return [];
  const round1 = (n) => Math.round(n * 10) / 10;
  return [...new Set([...r.keys(), ...p.keys()])].map((key) => {
    const recent = r.get(key) || 0;
    const prior = p.get(key) || 0;
    const recentShare = (recent / rTotal) * 100;
    const priorShare = (prior / pTotal) * 100;
    return {
      key, recent, prior, delta: recent - prior,
      recentShare: round1(recentShare), priorShare: round1(priorShare),
      shareDelta: round1(recentShare - priorShare),
    };
  }).sort((a, b) => Math.abs(b.shareDelta) - Math.abs(a.shareDelta));
}

// A share move smaller than this is mix noise, not a shift worth a finding.
export const MIN_SHARE_SHIFT_PP = 5;

export function splitShareShifts(shifts, { minShiftPp = MIN_SHARE_SHIFT_PP, limit = 8 } = {}) {
  const gainers = shifts.filter((s) => s.shareDelta >= minShiftPp).sort((a, b) => b.shareDelta - a.shareDelta).slice(0, limit);
  const droppers = shifts.filter((s) => s.shareDelta <= -minShiftPp).sort((a, b) => a.shareDelta - b.shareDelta).slice(0, limit);
  return { gainers, droppers };
}

// A single window clipped so it never reaches into the source's un-final
// days: GSC rows for the last ~3 days are still being backfilled, so a window
// ending 'today' silently undercounts its tail. Returns null when nothing
// final is left.
export function clipWindowToLag(win, lagDays = GSC_LAG_DAYS, today) {
  const cutoff = toYmd(toMs(todayYmd(today)) - lagDays * DAY_MS);
  const end = win.end > cutoff ? cutoff : win.end;
  return end < win.start ? null : { start: win.start, end };
}
