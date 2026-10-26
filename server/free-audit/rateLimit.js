// Small in-memory limiter: at most `max` hits per key within `windowMs`.
// Per-process, which is fine for a single container. Behind a proxy, set
// TRUST_PROXY so req.ip is the visitor and not the proxy.
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const fresh = times.filter((t) => t > cutoff);
      if (fresh.length) hits.set(key, fresh);
      else hits.delete(key);
    }
  }, windowMs);
  sweep.unref();

  // Returns 0 if allowed (and records the hit), else seconds until retry.
  return function take(key) {
    const now = Date.now();
    const times = (hits.get(key) || []).filter((t) => t > now - windowMs);
    if (times.length >= max) {
      hits.set(key, times);
      return Math.ceil((times[0] + windowMs - now) / 1000);
    }
    times.push(now);
    hits.set(key, times);
    return 0;
  };
}

export { createRateLimiter };
