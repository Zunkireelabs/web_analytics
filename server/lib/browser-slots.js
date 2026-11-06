// GLOBAL BROWSER CONCURRENCY — across every worker process, not just within one.
//
// Root cause being fixed: each process limited its own headless browsers, so N workers could run
// N x the limit at once and exhaust memory on the shared host. Each running browser now holds one of
// BROWSER_GLOBAL_SLOTS Postgres advisory locks for its whole lifetime. Advisory locks are owned by a
// database session, so a worker that crashes or is killed loses its connection and its slot is freed
// by the database itself — a slot can never leak.
//
// If the database cannot be reached, launches fall back to a per-process limit (logged once) rather
// than stopping all browser work.
const LOCK_NAMESPACE = 72001;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

export class BrowserCapacityError extends Error {
  constructor(message) { super(message); this.name = 'BrowserCapacityError'; this.code = 'BROWSER_CAPACITY'; this.transient = true; }
}

function localLimiter(max) {
  let active = 0; const waiters = [];
  return {
    async acquire() {
      if (active >= max) await new Promise((r) => waiters.push(r));
      active++;
      let done = false;
      return async () => { if (done) return; done = true; active--; waiters.shift()?.(); };
    },
  };
}

export function createBrowserSlots({
  getPool = async () => (await import('../db.js')).pool,
  slots = num(process.env.BROWSER_GLOBAL_SLOTS, 3),
  waitMs = num(process.env.BROWSER_SLOT_WAIT_MS, 120_000),
  pollMs = 400,
  log = console,
} = {}) {
  const fallback = localLimiter(slots);
  let warned = false;
  return {
    slots,
    /** Resolves to an async release() once a global slot is held; rejects with BrowserCapacityError after waitMs. */
    async acquire() {
      let client;
      try { client = await (await getPool()).connect(); } catch (err) {
        if (!warned) { warned = true; log.warn?.(`[browser-slots] database unavailable (${err.message}) — limiting browsers per process only`); }
        return fallback.acquire();
      }
      // A held session can die under us (database restart, admin terminate). Without a listener the
      // checked-out client's 'error' event would crash the whole worker; the database has already freed
      // the lock, so the only correct reaction is to note it.
      let sessionLost = false;
      const onError = (err) => { sessionLost = true; log.warn?.(`[browser-slots] slot session lost (${err.message}); the database released the slot`); };
      client.on('error', onError);
      const deadline = Date.now() + waitMs;
      try {
        for (;;) {
          for (let s = 0; s < slots; s++) {
            // eslint-disable-next-line no-await-in-loop
            const { rows } = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_NAMESPACE, s]);
            if (rows[0].ok) {
              let released = false;
              return async () => {
                if (released) return; released = true;
                if (!sessionLost) { try { await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, s]); } catch { /* session gone: the database already freed it */ } }
                client.removeListener('error', onError);
                client.release(sessionLost ? true : undefined); // a dead session is discarded, never returned to the pool
              };
            }
          }
          if (Date.now() >= deadline) throw new BrowserCapacityError(`All ${slots} browser slots are busy across workers; try again shortly.`);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, pollMs + Math.floor(Math.random() * pollMs)));
        }
      } catch (err) {
        client.removeListener('error', onError);
        client.release(sessionLost ? true : undefined);
        throw err;
      }
    },
  };
}

let shared = null;
export const browserSlots = () => { shared = shared || createBrowserSlots(); return shared; };

/** Launch through a held slot; the slot is released when the browser closes OR dies. */
export async function launchWithSlot(launch) {
  const release = await browserSlots().acquire();
  try {
    const browser = await launch();
    browser.on?.('disconnected', () => { release().catch(() => {}); });
    return browser;
  } catch (err) {
    await release().catch(() => {});
    throw err;
  }
}
