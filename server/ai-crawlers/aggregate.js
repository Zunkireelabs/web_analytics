import { parseLine } from './parse-log.js';
import { classifyUserAgent } from './bots.js';
import { verifyVisit } from './verify.js';

// Log lines -> daily counts, which is all that is ever stored (13 months of these; no raw lines, no visitor addresses).
//
// Pure and site-agnostic on purpose: it knows nothing about WHICH project the lines belong to. The upload endpoint decides
// that from the credential used, never from anything in the payload, so one project's lines can never be filed under
// another's (see the multi-tenant note in the plan). Run it once per upload, per project.

export const OTHER_PATH = '(other)';
export const DEFAULT_MAX_PATHS_PER_DAY = 500;

/**
 * @param {Iterable<string>} lines  access-log lines
 * @param {{ ranges: object, maxPathsPerDay?: number }} opts  ranges: from compileRanges()
 * @returns {{ rows: Array<{day, botId, path, status, verification, hits}>, stats: object }}
 *
 * A crawler stuck in a loop (or a scanner using a bot user agent) can request millions of distinct URLs. Past
 * `maxPathsPerDay` distinct paths on one day, further new paths are counted under "(other)" so storage stays bounded while
 * the totals stay true.
 */
export function aggregateLines(lines, { ranges, maxPathsPerDay = DEFAULT_MAX_PATHS_PER_DAY } = {}) {
  const counts = new Map();
  const pathsByDay = new Map();
  const stats = { linesRead: 0, unparseable: 0, notBot: 0, ownExcluded: 0, botVisits: 0, byVerification: { verified: 0, unverified: 0, unchecked: 0 }, pathsFolded: 0 };

  for (const line of lines) {
    if (line == null || line === '') continue;
    stats.linesRead++;
    const rec = parseLine(line);
    if (!rec) { stats.unparseable++; continue; }
    const hit = classifyUserAgent(rec.userAgent);
    if (!hit) { stats.notBot++; continue; }
    if (hit.own) { stats.ownExcluded++; continue; }

    const verification = verifyVisit(hit.bot, rec.clientIp, ranges);
    let seen = pathsByDay.get(rec.day);
    if (!seen) pathsByDay.set(rec.day, (seen = new Set()));
    let path = rec.path;
    if (!seen.has(path)) {
      if (seen.size >= maxPathsPerDay) { path = OTHER_PATH; stats.pathsFolded++; } else seen.add(path);
    }

    // The visitor address is used above for verification and goes no further: it is not part of this key.
    const key = `${rec.day}\u0000${hit.bot.id}\u0000${path}\u0000${rec.status}\u0000${verification}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    stats.botVisits++;
    stats.byVerification[verification]++;
  }

  const rows = [...counts.entries()].map(([key, hits]) => {
    const [day, botId, path, status, verification] = key.split('\u0000');
    return { day, botId, path, status: Number(status), verification, hits };
  }).sort((a, b) => a.day.localeCompare(b.day) || a.botId.localeCompare(b.botId) || a.path.localeCompare(b.path) || a.status - b.status || a.verification.localeCompare(b.verification));
  return { rows, stats };
}

/**
 * Enforce the per-day distinct-path cap across uploads. `existingByDay` is a Map(day -> Set(paths already stored for this
 * project that day)). A path already stored keeps its own row; a NEW path is allowed only while the day has room, and
 * otherwise folds into "(other)". Rows that end up with the same key after folding are merged, so totals stay exact.
 * Pure: the storage layer reads the existing paths and passes them in.
 */
export function applyDailyPathCap(rows, existingByDay, maxPathsPerDay = DEFAULT_MAX_PATHS_PER_DAY) {
  const known = new Map(); // day -> Set of paths that will exist after this batch
  const merged = new Map();
  for (const r of rows) {
    let seen = known.get(r.day);
    // "(other)" is where overflow lands, not a real path, so it never uses up a slot.
    if (!seen) known.set(r.day, (seen = new Set([...(existingByDay?.get(r.day) || [])].filter((p) => p !== OTHER_PATH))));
    let path = r.path;
    if (path !== OTHER_PATH && !seen.has(path)) {
      if (seen.size >= maxPathsPerDay) path = OTHER_PATH; else seen.add(path);
    }
    const key = `${r.day}\u0000${r.botId}\u0000${path}\u0000${r.status}\u0000${r.verification}`;
    const prev = merged.get(key);
    if (prev) prev.hits += r.hits; else merged.set(key, { ...r, path });
  }
  return [...merged.values()];
}
