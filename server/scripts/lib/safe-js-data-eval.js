import vm from 'node:vm';

// Evaluates an Eleventy-style `src/_data/*.js` file's exported value WITHOUT
// executing it as part of a build or write path — used only by
// discover-url-file-map.js to inspect a data file's real shape before
// proposing it as a config candidate. This mirrors a trust boundary that
// already exists: Eleventy itself executes these exact files at the
// client's own build time, so reading the value here isn't a new exposure,
// just doing once, read-only, what the client's own CI already does on
// every deploy.
//
// Deliberately bounded, not a general-purpose JS sandbox: the context has
// no `require`, `process`, `fs`, `fetch`, or any global beyond bare
// JavaScript, and execution is time-limited. A file that references any of
// those (import of another module, environment access, network calls)
// throws inside the sandbox and this returns `undefined` — the caller
// treats that as "could not verify," never as an error to surface loudly,
// since plenty of legitimate _data files do exactly that and simply aren't
// safe to evaluate this way.
const TIMEOUT_MS = 1000;

function normalizeToCommonJs(source) {
  // Only handles the single-default-export shape real _data files use in
  // practice (`export default [...]`) — anything with named exports still
  // contains `export ` after this and is left to fail closed below rather
  // than partially transformed.
  return source.replace(/export\s+default\s+/, 'module.exports = ');
}

export function safeEvalJsDataFile(source) {
  if (/\bexport\s+(?!default\s)/.test(source)) return undefined; // named exports — not normalized, don't guess

  const normalized = normalizeToCommonJs(source);
  const wrapped = `(function () {
    const module = { exports: {} };
    const exports = module.exports;
    ${normalized}
    return module.exports;
  })()`;

  try {
    const context = vm.createContext(Object.create(null));
    const script = new vm.Script(wrapped, { timeout: TIMEOUT_MS });
    return script.runInContext(context, { timeout: TIMEOUT_MS });
  } catch {
    return undefined; // require()/process/network access, syntax it can't handle, or a real timeout — all fail closed
  }
}
