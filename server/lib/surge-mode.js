// FIRST-30-DAY SURGE MODE: a new project may take more autonomous work per day while it is new.
//
// It changes ONE number, the site's daily limit (60 -> 100), and nothing else. The hard 100 ceiling, the analyst lane,
// every approval and validation gate, failure quarantine, GitHub rate limits and design protections are untouched, and
// capacity is only ever used when validated, shippable work exists (lib/autonomous-quota.js never pads a day).
//
// The clock is sites.surge_mode_until (migration 242). NULL = off, which is every project that existed before it.
import { DEFAULT_SITE_LIMIT, SURGE_SITE_LIMIT } from './autonomous-quota.js';

export const SURGE_DAYS = 30;
const MS_DAY = 24 * 60 * 60 * 1000;

// Pure. until: the sites.surge_mode_until value. Never throws; anything unreadable is "off" (normal capacity).
export function surgeStatus(until, now = new Date()) {
  const end = until ? new Date(until) : null;
  if (!end || Number.isNaN(end.getTime())) return { active: false, reason: 'not-enabled', activatedAt: null, expiresAt: null, day: null, daysLeft: 0 };
  const start = new Date(end.getTime() - SURGE_DAYS * MS_DAY);
  const expiresAt = end.toISOString();
  if (now.getTime() >= end.getTime()) return { active: false, reason: 'expired', activatedAt: start.toISOString(), expiresAt, day: null, daysLeft: 0 };
  const day = Math.min(SURGE_DAYS, Math.max(1, Math.floor((now.getTime() - start.getTime()) / MS_DAY) + 1));
  return { active: true, reason: 'active', activatedAt: start.toISOString(), expiresAt, day, daysLeft: Math.max(0, Math.ceil((end.getTime() - now.getTime()) / MS_DAY)) };
}

// The site's daily limit as the day is sized. 60 is the DEFAULT, so only a site still at 60 is raised; any explicit
// different value (a lower cap, 0 to pause, or a deliberate higher one) is respected as is. Surge never lowers a limit.
export function effectiveSiteLimit(siteLimit, surge) {
  if (siteLimit == null) return siteLimit;
  if (surge?.active && Number(siteLimit) === DEFAULT_SITE_LIMIT) return SURGE_SITE_LIMIT;
  return siteLimit;
}
