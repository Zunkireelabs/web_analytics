// The two decisions the autonomous shipping run and its catch-up guard make
// about a site, kept here rather than inline in job.js so they can be tested
// without dragging in job.js's whole dependency graph (GSC/GA4 clients, Google
// auth, every store module) — no existing test imports job.js for that reason.
//
// Both are pure: the caller supplies the clock and the already-shipped count.

// The hour, in each SITE's own timezone, at which the day's detected
// recommendations get shipped as a branch + PR. THE one definition — job.js's
// cron entry and its catch-up guard both read it from here, because a
// hand-mirrored copy of this hour is exactly the kind of constant this
// codebase has already had go stale twice.
//
// 07:00, matching CRON_SCHEDULE: detection and shipping are now one morning
// run (cron.js), so the day's work lands in a single pass — gather, open the
// PRs, send the mail. The 13:00 split this replaced existed to give "a single
// moment a human could expect to review a day's work" instead of branches
// appearing at whatever hour analysis happened to finish; one 07:00 run
// serves that intent more directly than two runs six hours apart did. The
// review itself is unchanged and still happens on the PR, which is where
// autonomy has always ended.
export const SHIP_HOUR_LOCAL = Number(process.env.SHIP_HOUR_LOCAL || 7);

// How late a missed 07:00 run can still be recovered. Without an upper bound
// the hourly catch-up guard below owes shipping at literally any hour past
// SHIP_HOUR_LOCAL — including a stray local dev process started at 7 PM with
// production credentials, which is exactly how PR #55 on zunkireelabs-web got
// opened outside the intended morning window. Four hours gives the daily job
// and its own hourly guard (job.js) room to recover from a normal missed
// wake-up without leaving the window open all day.
export const SHIP_CATCHUP_END_HOUR_LOCAL = Number(process.env.SHIP_CATCHUP_END_HOUR_LOCAL || 11);

// Whether a site is eligible to have work SHIPPED at all. Deliberately keyed
// on the repo, not on GSC/GA4 (listConnectedSites' filter): a site with
// analytics but no repository has nowhere to push a branch. The
// auto_remediation_enabled flag stays the real per-tenant opt-in on top of
// this — this is only "could it physically ship", not "should it".
export function isShippable(site) {
  return Boolean(site?.repo_owner && site?.repo_name);
}

// Local hour in an arbitrary IANA timezone, without pulling in a date library.
export function hourInTimezone(timezone, now = new Date()) {
  return new Date(now.toLocaleString('en-US', { timeZone: timezone })).getHours();
}

// The catch-up guard's whole decision. Work is owed when this site's own ship
// hour has passed and the scheduled run has budget left unused today.
//
// Originally gated on `alreadyShippedToday > 0` alone — "the morning run
// shipped nothing" — which missed the more common real case: the morning run
// shipped SOMETHING but stopped well short of the daily budget (the
// consecutive-failure circuit breaker tripping mid-run, or a transient error
// aborting the pass early) and the remaining budgeted items just sat there
// unattempted until tomorrow. Comparing against the site's own daily limit
// instead catches both shapes with one check, and still skips a site that
// already used its whole budget, which a bare `alreadyShippedToday > 0` check
// coincidentally also did for the (usual) case of one shipped item meeting a
// small limit — but not for the common case of a large limit with plenty left.
//
// "Shipped so far" is measured as drafts auto-remediation created today in
// the SITE's timezone — the same measure auto-remediation uses for its own
// daily budget — rather than a new state column, so the guard can never
// disagree with the thing it is guarding. A site that legitimately had zero
// candidates (or is already at its limit) re-checks cheaply each hour, the
// same trade the existing daily narrative guard already makes, and a
// recommendation detected later in the day still ships the same day onto the
// same batch branch/PR.
export function isShipCatchupOwed({ site, alreadyShippedToday, fallbackTimezone = 'UTC', now = new Date() }) {
  if (!isShippable(site)) return false;
  const dailyLimit = site.auto_remediation_daily_limit ?? 60;
  if (alreadyShippedToday >= dailyLimit) return false;
  const hour = hourInTimezone(site.timezone || fallbackTimezone, now);
  return hour >= SHIP_HOUR_LOCAL && hour < SHIP_CATCHUP_END_HOUR_LOCAL;
}
