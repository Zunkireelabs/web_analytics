// Safety rails for command-line scripts that can WRITE shared data (learning review, model registry, memory snapshots,
// industry refresh). The developer's default DATABASE_URL points at the live database, so a script run casually could change
// production. Rule: a write against anything but a local database needs the explicit --allow-remote flag AND a named person
// (--by). Reads are never blocked, but every script prints which database it is talking to.

export const LOCAL_HOST = /^(localhost|127\.0\.0\.1|::1)$/i;

export function databaseHost(env = process.env) {
  try { return new URL(env.DATABASE_URL).hostname.replace(/^\[|\]$/g, ''); } catch { return null; }
}

export const isLocalDatabase = (env = process.env) => LOCAL_HOST.test(databaseHost(env) || '');

// Pure. Returns { ok, reason } so tests can check it without exiting.
export function checkWriteAllowed(flags = {}, env = process.env) {
  const host = databaseHost(env);
  if (!host) return { ok: false, reason: 'DATABASE_URL is missing or not a valid URL' };
  if (LOCAL_HOST.test(host)) return { ok: true, host, local: true };
  if (!flags['allow-remote']) {
    return { ok: false, host, reason: `this would WRITE to a non-local database (${host}). Re-run against a local database, or pass --allow-remote --by "<your name>" if the owner has approved this change.` };
  }
  if (!flags.by || !String(flags.by).trim()) return { ok: false, host, reason: `a remote write (${host}) must name who is making it: add --by "<your name>"` };
  return { ok: true, host, local: false };
}

export function requireWriteAllowed(flags, env = process.env) {
  const r = checkWriteAllowed(flags, env);
  if (!r.ok) throw new Error(`Write refused: ${r.reason}`);
  return r;
}

export function announceDatabase(env = process.env, log = console.error) {
  const host = databaseHost(env);
  log(`[database] ${host ? (LOCAL_HOST.test(host) ? `local (${host})` : `REMOTE (${host})`) : 'unknown'}`);
}
