// Single source of truth for MCP permission-tier ordering. Every place that
// needs "is level X at least as capable as level Y" imports atLeast() from
// here rather than comparing strings independently — adding a 5th tier
// later is a one-line change in exactly this file, nowhere else.

export const PERMISSION_LEVELS = ['read_only', 'ai_actions', 'automation', 'admin'];

export const LEVEL_RANK = Object.fromEntries(PERMISSION_LEVELS.map((l, i) => [l, i]));

export const DEFAULT_PERMISSION_LEVEL = 'read_only';

// -1 for an unrecognized level so an unexpected/corrupt value always fails
// closed rather than silently matching every atLeast('read_only') check.
export function atLeast(level, min) {
  return (LEVEL_RANK[level] ?? -1) >= LEVEL_RANK[min];
}
