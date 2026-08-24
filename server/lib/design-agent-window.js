// Whether the Design Agent worker should claim a queued design_generate job
// right now. Kept here, not inline in worker.js, so it can be unit-tested
// without the DB — same reasoning as ship-window.js's split.
//
// A design_generate job spins up a memory-heavy sibling Docker container
// (openhands-agent-server) that competes directly with this VPS's other
// always-on containers (analytics-app, mcp, data-analyst-agent) for RAM.
// Job 628 on site 1 was killed ("Container stopped unexpectedly") at
// 2026-08-24 00:30 UTC — inside the nightly load window: the data-analyst
// nightly pipeline starts at 22:00 UTC and server/cron.js's Action Center
// sync runs at 00:00 UTC, and a design_generate job gets queued as a direct
// side effect of that sync (a fresh recommendation needing a template it
// doesn't have yet). Without a guard, every job lands in exactly the box's
// worst memory window by construction, not by bad luck.
//
// UTC, not per-site timezone, deliberately: this isn't about when a
// tenant's day starts (that's ship-window.js's SHIP_HOUR_LOCAL), it's about
// when THIS SERVER's other containers are under load — one clock for every
// site's jobs, because they all share the one box.
export const DESIGN_AGENT_QUIET_START_HOUR_UTC = Number(process.env.DESIGN_AGENT_QUIET_START_HOUR_UTC ?? 21);
export const DESIGN_AGENT_QUIET_END_HOUR_UTC = Number(process.env.DESIGN_AGENT_QUIET_END_HOUR_UTC ?? 2);

// The window wraps past midnight (21 -> 2), so it can't be a plain
// start <= hour < end range check — it's "at or after start, OR before end"
// whenever start > end. Equal start/end disables the guard entirely (an
// operator override, e.g. to unblock a manual re-check by hand).
export function isDesignAgentQuietHours(now = new Date(), {
  start = DESIGN_AGENT_QUIET_START_HOUR_UTC,
  end = DESIGN_AGENT_QUIET_END_HOUR_UTC,
} = {}) {
  const hour = now.getUTCHours();
  if (start === end) return false;
  return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}
