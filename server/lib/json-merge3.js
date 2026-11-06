// Three-way JSON merge, used to RECOVER a url_file_map write that the database refused as stale
// (migration 249). base = the version the writer read, theirs = the row as it is now (someone else
// wrote in between), ours = what the writer wants to store.
//
// Rules, per key, recursively through plain objects:
//   ours == base               -> keep theirs (we did not touch it)
//   theirs == base             -> take ours   (only we changed it)
//   ours == theirs             -> either      (both made the same change)
//   both changed, both objects -> recurse
//   otherwise                  -> CONFLICT (both changed the same value differently)
// Arrays and scalars are atomic values. A conflict is never resolved by guessing: the caller gets
// the list of conflicting paths and the write fails loudly instead of losing someone's change.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const same = (a, b) => stableStringify(a) === stableStringify(b);
const ABSENT = Symbol('absent');
const get = (o, k) => (isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : ABSENT);

export function merge3(base, theirs, ours, { ignore = ['_rev'], path = [] } = {}) {
  const conflicts = [];
  const merged = mergeObj(base, theirs, ours, path, conflicts, new Set(ignore));
  return { merged, conflicts };
}

function mergeValue(b, t, o, path, conflicts, ignore) {
  if (same(o, b)) return t;
  if (same(t, b)) return o;
  if (same(o, t)) return o;
  if (isObj(o) && isObj(t) && (isObj(b) || b === ABSENT)) return mergeObj(isObj(b) ? b : {}, t, o, path, conflicts, ignore);
  conflicts.push(path.join('.') || '(root)');
  return t;
}

function mergeObj(base, theirs, ours, path, conflicts, ignore) {
  const out = {};
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(theirs || {}), ...Object.keys(ours || {})]);
  for (const k of keys) {
    if (path.length === 0 && ignore.has(k)) { if (get(theirs, k) !== ABSENT) out[k] = theirs[k]; continue; }
    const v = mergeValue(get(base, k), get(theirs, k), get(ours, k), [...path, k], conflicts, ignore);
    if (v !== ABSENT) out[k] = v;
  }
  return out;
}
