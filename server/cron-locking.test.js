import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression guard for the cron audit: every scheduled lane must take a database-backed lock, so two app
// instances sharing one database (staging + production, a second worker, a laptop left on) cannot run the
// same lane at once. A new cron.schedule(...) that skips this fails here until it locks or is listed, with
// a reason, as safe.
// Comments are stripped first, so a mention of `locked('` in prose cannot make a lane look locked.
const src = readFileSync(fileURLToPath(new URL('./cron.js', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Lanes that are safe WITHOUT a lane-level lock, and why.
const PER_SITE_LOCKED = new Set([
  "'35 * * * *'", // shipping catch-up: takes each site's ship lock and its GitHub-credential lock (job.js shipSiteWithLocks)
]);

test('every cron.schedule callback runs under a job lock', () => {
  const calls = [...src.matchAll(/cron\.schedule\(\s*([^,]+),/g)];
  assert.ok(calls.length >= 15, `expected to find the scheduled lanes, found ${calls.length}`);
  const unlocked = [];
  for (const m of calls) {
    const key = m[1].trim();
    const end = src.indexOf('{ timezone: tz }', m.index);
    const block = src.slice(m.index, end);
    if (/locked\('|withJobLock\(/.test(block)) continue;
    if (PER_SITE_LOCKED.has(key)) continue;
    unlocked.push(key);
  }
  assert.deepEqual(unlocked, [], `scheduled lanes without a lock: ${unlocked.join(', ')}`);
});

test('lane names are unique, so two different lanes never share a lock', () => {
  const names = [...src.matchAll(/(?:locked|jobKeyFor)\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  const lockedNames = [...src.matchAll(/locked\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.equal(new Set(lockedNames).size, lockedNames.length);
  assert.ok(names.length > 0);
});
