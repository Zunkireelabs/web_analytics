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

// THE lock identity for a site's autonomous shipping run — the scheduled run
// and its hourly catch-up guard must contend for the SAME key, or the guard
// can open a second batch branch and a second PR alongside a run already in
// flight, and a client's day stops being one reviewable commit.
//
// Keyed per SITE, deliberately not one platform-wide key. A single key around
// the whole multi-site loop meant one slow tenant stalled every other
// tenant's PR for the rest of the pass, and a lease expiring mid-run let a
// second process restart the ENTIRE pass instead of just the site that
// stalled. Per-site, a tenant can only ever block itself, while the
// cross-process protection the lock exists for (the 2026-09-08 laptop-vs-VPS
// double-run) is unchanged: two processes still cannot ship one site at once.
//
// Lives here rather than inline at the call sites because the two callers
// agreeing is the entire safety property; a hand-mirrored copy of this string
// is exactly the kind of constant this codebase has already had go stale.
export const SHIP_LOCK_JOB_NAME = 'auto-remediation-ship';

// A SEPARATE lock from the one above, keyed by GitHub credential identity
// (github/client.js's rateLimitKey), not by site. The per-site lock above
// only stops one process from shipping the SAME site twice — it was
// (correctly) widened from one platform-wide lock specifically so that an
// unrelated tenant is never stalled by a slow one. But two DIFFERENT sites
// sharing one GitHub App installation (the common case before a tenant gets
// its own — both live tenants as of 2026-09 share installation 153416356)
// can now legitimately be shipped by two different processes at the same
// moment, and each process's in-memory rate-limit tracking
// (lastRateLimitByCredential in github/client.js) is process-local — so
// neither process's pre-ship budget check sees the other's spending. That
// reopens exactly the double-spend the site-level lock's own comment says is
// "unchanged": it isn't, once two sites share a token. This lock closes that
// gap without reintroducing the platform-wide stall: a tenant on its own
// credential is never blocked by this key at all, and two tenants sharing
// one credential simply ship one at a time, same as before the per-site
// change — which is the correct, load-bearing behavior for a shared budget,
// not a regression of it.
export const GITHUB_CREDENTIAL_LOCK_JOB_NAME = 'auto-remediation-ship-credential';

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
  const dailyLimit = siteDailyTarget(site);
  if (alreadyShippedToday >= dailyLimit) return false;
  const hour = hourInTimezone(site.timezone || fallbackTimezone, now);
  return hour >= SHIP_HOUR_LOCAL && hour < SHIP_CATCHUP_END_HOUR_LOCAL;
}

// The one place "how many was this site supposed to ship today" is resolved
// for both the catch-up guard above and the stall check below — an explicit
// per-site override when set, else the same 60 auto-remediation itself
// defaults to (laneBudgets' NORMAL_TARGET is 80 across both lanes combined,
// but this file only ever measures the auto-remediation source specifically,
// matching what isShipCatchupOwed already compared against before this was
// pulled out into its own function).
export function siteDailyTarget(site) {
  return site.auto_remediation_daily_limit ?? 60;
}

// A day this far under its own target is not "a slow day," it is a day
// something broke silently — the 2026-09-12 incident this exists for
// (Chayceproperties shipping 9 instead of ~60-80 because a missing GitHub
// App secret made every draft abandon with "GitHub App is not configured")
// went unnoticed for a full day because nothing compared the day's real
// output to what it should have been. Deliberately NOT gated on
// `attempted > 0` — a total no-op day for a site that should have plenty of
// eligible work is itself the failure mode, not a reason to stay quiet.
export const SHIP_STALL_RATIO = 0.25;

// Pure — no DB, no cooldown — so it's testable on its own. The caller (job.js)
// is responsible for the cooldown check (once-per-site-per-day, matching the
// hasRecentNotification pattern every other notification event already uses)
// and for actually delivering the event via deliverToAllChannels.
export function checkShipStall({ site, shipped, now = new Date() }) {
  const target = siteDailyTarget(site);
  if (target <= 0) return null; // paused tenant — a stall check is meaningless
  if (shipped >= SHIP_STALL_RATIO * target) return null;
  const today = now.toISOString().slice(0, 10);
  return {
    type: 'ship-stall', severity: 'high',
    title: `${site.name}: shipped only ${shipped} of an expected ~${target} fixes today`,
    body: `On ${today}, ${site.name}'s autonomous Action Center shipped ${shipped} fix${shipped === 1 ? '' : 'es'} against a daily target of ${target} — well below what's expected. Check for a silent shipping failure (e.g. a missing or expired credential) before assuming this was just a quiet day.`,
    findingIds: [],
  };
}
