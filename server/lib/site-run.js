// Fair, bounded per-site processing for the "for all sites" passes.
//
// Two problems this solves: sites always ran in id order, so the newest projects (highest
// ids, i.e. every self-serve one) were always last and the first to lose a day when a pass
// overran; and nothing bounded one site, so a single slow or hung site could hold the whole
// pass (and its lock) until it gave up on its own.

const DAY_MS = 24 * 60 * 60 * 1000;

// Starts the list at a different site each day (same order, rotated), so nobody is
// permanently first or last. Deterministic for a given day, so a re-run the same day
// walks the same order.
export function rotateForToday(list, now = Date.now()) {
  if (!Array.isArray(list) || list.length < 2) return list || [];
  const offset = Math.floor(now / DAY_MS) % list.length;
  return [...list.slice(offset), ...list.slice(0, offset)];
}

// The sites whose open work matters most go first. `urgency` is Map<siteId, number of open high-priority recommendations>. Sites with equal urgency keep the order they
// came in (the daily rotation), so nobody is permanently last and a site with only lower-priority work still runs, just later in the pass. Pure and stable: a missing
// or empty map returns the list unchanged.
export function orderByUrgency(list, urgency) {
  if (!Array.isArray(list) || list.length < 2 || !(urgency instanceof Map) || urgency.size === 0) return list || [];
  return list.map((site, i) => ({ site, i, u: Number(urgency.get(site.id)) || 0 })).sort((a, b) => (b.u - a.u) || (a.i - b.i)).map((x) => x.site);
}

// Within a working day with several passes (the laptop worker's session runs one every 20+ minutes), whoever was served longest ago goes first: a project not yet
// reached today leads, then the one whose last pass is oldest, and the urgency order (the list as given) breaks ties. Without this the project with the most
// high-priority work leads EVERY pass and spends its 30-minute allowance first each time. `servedAt` is Map<siteId, ms of that project's last pass today>.
// Pure and stable: an empty or missing map returns the list unchanged, so on the day's first pass the urgency order is exactly what it was.
export function orderByTurn(list, servedAt) {
  if (!Array.isArray(list) || list.length < 2 || !(servedAt instanceof Map) || servedAt.size === 0) return list || [];
  return list.map((site, i) => ({ site, i, t: servedAt.has(site.id) ? Number(servedAt.get(site.id)) : -Infinity })).sort((a, b) => (a.t - b.t) || (a.i - b.i)).map((x) => x.site);
}

// One client gets 30 minutes for its detection work and 30 for shipping; then the pass moves to the next client.
export const SITE_RUN_TIMEOUT_MS = Number(process.env.SITE_RUN_TIMEOUT_MS) || 30 * 60 * 1000;

// The whole morning run (07:00 to 11:00) is one window. When it closes, no NEW client is started: whoever was not
// reached is left for the hourly catch-up and, because the order rotates, goes earlier in tomorrow's run.
export const RUN_WINDOW_MS = Number(process.env.RUN_WINDOW_MS) || 4 * 60 * 60 * 1000;
export const windowClosed = (endsAt, now = Date.now()) => endsAt != null && now >= endsAt;
// How long past its soft deadline a site may keep running before the pass stops waiting for it.
export const SITE_RUN_GRACE_MS = Number(process.env.SITE_RUN_GRACE_MS) || 5 * 60 * 1000;

/**
 * Runs `fn({ deadlineAt })` for one site with a time budget.
 *
 * Soft deadline: `fn` is handed `deadlineAt` and is expected to stop STARTING new work
 * past it, at a point where stopping is safe (between items, never mid-push). That is the
 * only way to truly stop work safely, so loops that can run long must honour it.
 *
 * Hard limit (soft + grace): if `fn` still has not returned, the pass stops waiting and
 * moves on. The abandoned call cannot be killed from here, so its own per-request timeouts
 * (Google API calls carry one) are what end it; a per-site lock it holds frees when it does.
 * The timeout is recorded via `onTimeout` so it is visible, not just logged.
 *
 * Resolves { ok: true, value } | { ok: false, timedOut: true } | { ok: false, error }.
 */
export async function runSiteWithDeadline(site, fn, {
  timeoutMs = SITE_RUN_TIMEOUT_MS, graceMs = SITE_RUN_GRACE_MS, label = 'run', onTimeout = null, now = () => Date.now(),
} = {}) {
  const deadlineAt = now() + timeoutMs;
  let aborted = false; // set when the pass stops waiting; the abandoned run checks it between steps and stops
  const isAborted = () => aborted;
  let timer;
  const hard = new Promise((resolve) => {
    timer = setTimeout(() => { aborted = true; resolve({ ok: false, timedOut: true }); }, timeoutMs + graceMs);
  });
  const work = Promise.resolve()
    .then(() => fn({ deadlineAt, isAborted }))
    .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  const outcome = await Promise.race([work, hard]);
  clearTimeout(timer);
  if (outcome.timedOut) {
    console.error(`[site-run] ${label} for site ${site?.id} "${site?.name}" exceeded ${Math.round((timeoutMs + graceMs) / 60000)} min — moving on to the next site.`);
    try { await onTimeout?.(site, label); } catch (err) { console.error('[site-run] could not record the timeout:', err.message); }
    // The abandoned call may still reject later; that must not become an unhandled rejection.
    work.catch(() => {});
  }
  return outcome;
}
