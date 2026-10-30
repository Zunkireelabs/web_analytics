import session from 'express-session';

// A thin cache in front of the real session store (connect-pg-simple, a table in the database).
//
// Why it exists: the app server and its database are far apart (France and Singapore), so every database call
// costs about 170 ms. The stock store makes two of them on EVERY request: a read of the session before the route
// runs, and a "touch" (an UPDATE that pushes the expiry forward) before the response is finished. This keeps a
// session read in memory for a few seconds and sends a touch at most once per interval, so a page that makes ten
// API calls pays for the session once, not twenty times.
//
// What it does not change: sessions are still saved and destroyed in the real store at once, and anything that
// changes a session (sign-in, switching project, sign-out) drops the cached copy first, so this process never
// serves a session it has itself just changed. It assumes ONE app process (the deploy runs one container); with
// several, another process could serve a switched project for up to READ_TTL_MS. The account and membership checks
// in requireAuth still run on every request, so disabling a user or removing them from a workspace is not delayed.
export const READ_TTL_MS = 10_000;
export const TOUCH_EVERY_MS = 10 * 60_000;
const MAX_ENTRIES = 2000;

export class CachedSessionStore extends session.Store {
  constructor(inner, { now = () => Date.now(), readTtlMs = READ_TTL_MS, touchEveryMs = TOUCH_EVERY_MS } = {}) {
    super();
    this.inner = inner;
    this.now = now;
    this.readTtlMs = readTtlMs;
    this.touchEveryMs = touchEveryMs;
    this.reads = new Map();    // sid -> { sess, at }
    this.touched = new Map();  // sid -> time of the last touch sent
  }

  #trim(map) {
    if (map.size <= MAX_ENTRIES) return;
    for (const key of map.keys()) { map.delete(key); if (map.size <= MAX_ENTRIES * 0.8) break; }
  }

  get(sid, cb) {
    const hit = this.reads.get(sid);
    if (hit && this.now() - hit.at < this.readTtlMs) return cb(null, JSON.parse(hit.json));
    this.inner.get(sid, (err, sess) => {
      if (err) return cb(err);
      if (sess) { this.reads.set(sid, { json: JSON.stringify(sess), at: this.now() }); this.#trim(this.reads); } else this.reads.delete(sid);
      cb(null, sess);
    });
  }

  set(sid, sess, cb) {
    this.reads.delete(sid);
    this.touched.set(sid, this.now());
    this.inner.set(sid, sess, cb);
  }

  destroy(sid, cb) {
    this.reads.delete(sid);
    this.touched.delete(sid);
    this.inner.destroy(sid, cb);
  }

  touch(sid, sess, cb) {
    const last = this.touched.get(sid);
    if (last != null && this.now() - last < this.touchEveryMs) return cb?.(null);
    this.touched.set(sid, this.now());
    this.#trim(this.touched);
    this.reads.delete(sid);
    return this.inner.touch ? this.inner.touch(sid, sess, cb) : cb?.(null);
  }
}
