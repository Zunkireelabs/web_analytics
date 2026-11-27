// Runs a list of projects with a bounded number at once, in the order given.
//  - `keyOf(site)`: projects with the same key (one GitHub credential) never run together; the next one with a free key goes first and the waiting one starts when it frees.
//  - `halt()`: checked before each start; returns null to continue, or a reason ('window', 'ceiling') after which nothing new starts. Work already running finishes.
//  - `onHalt(reason, notStarted)`: called once, after the running work is done, with the projects that were never started.
// Never throws: one project's error is reported to `onError` and the rest carry on. Pure scheduling, no database, so it is testable on its own.
export async function runSitesConcurrently({ sites, concurrency = 1, keyOf = () => null, halt = () => null, processSite, onHalt = async () => {}, onError = () => {} }) {
  const pending = [...sites];
  const inFlight = new Set();
  let active = 0; let halted = null; let finished = false;
  await new Promise((resolve) => {
    const settle = async () => {
      if (finished || active > 0 || (!halted && pending.length)) return;
      finished = true;
      if (halted) await onHalt(halted, pending.splice(0)).catch(() => {});
      resolve();
    };
    const pump = () => {
      while (!halted && active < Math.max(1, concurrency) && pending.length) {
        const reason = halt();
        if (reason) { halted = reason; break; }
        const at = pending.findIndex((candidate) => { const k = keyOf(candidate); return k == null || !inFlight.has(k); });
        if (at < 0) break; // everything left shares a key that is running right now: it starts when that one finishes
        const [site] = pending.splice(at, 1);
        const key = keyOf(site);
        if (key != null) inFlight.add(key);
        active++;
        Promise.resolve().then(() => processSite(site)).catch((err) => onError(site, err))
          .finally(() => { if (key != null) inFlight.delete(key); active--; pump(); });
      }
      settle().catch(() => {});
    };
    pump();
  });
}
