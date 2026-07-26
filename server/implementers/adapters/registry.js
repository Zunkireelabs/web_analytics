import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Auto-discovers named adapters — same pattern as ../registry.js (and
// agents/registry.js, generators/registry.js). An adapter is a full
// replacement for the default backend/frontend implementer on a specific
// (site, page, action type), selected via url_file_map.pages[url].adapters[actionType]
// = '<adapter-id>' (see lib/url-file-map.js's resolveAdapter). Unlike the
// default implementers (routed globally by action type via `handles`), an
// adapter is resolved per page config — so it isn't auto-wired to any
// action type here; routes/action-center.js (via resolve.js) looks one up
// by id only when a page's adapter config asks for it. This is a separate,
// unrelated decision from render mode (visible/schema-only) — see
// implementers/types.js.
//
// An adapter owns entirely how and where it writes the change — an Eleventy
// data file, a React component, a Nunjucks include, a Markdown file, a CMS
// API call, anything. It is NOT assumed to be "a UI component." Directory is
// empty today: building a real adapter (e.g. one that understands a
// specific site's existing FAQ accordion data source) is done per-adapter
// when actually needed, not spec'd out in advance for frameworks/components
// this codebase doesn't have yet.
//
// Contract every file here must export:
//   export const meta = { id, description };
//   export async function apply(site, draft) { ... }   // -> ApplyResult (implementers/types.js)
//   export async function mergeToStage(site, draft) { ... }  // -> same shape as ApplyResult's merge step
// Adapters typically implement these by reusing pushDraftBranch/openPrForBranch
// from ../lib/github-ops.js internally (same as backend.js/frontend.js do),
// but nothing requires that — an adapter that writes to a non-GitHub target
// (e.g. a CMS API) just needs to return the same result shape.

const HERE = dirname(fileURLToPath(import.meta.url));
const NON_ADAPTER_FILES = new Set(['registry.js']);

let cache = null;

async function loadAll() {
  if (cache) return cache;
  // .test.js files (node:test suites living alongside their adapter, e.g.
  // data-array-content.test.js) never export the adapter shape — excluded
  // by suffix rather than added one-by-one to NON_ADAPTER_FILES, so a
  // future adapter's own test file doesn't need a matching registry edit.
  const files = readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && !NON_ADAPTER_FILES.has(f));

  const adapters = new Map();
  for (const file of files) {
    const mod = await import(pathToFileURL(join(HERE, file)).href);
    if (!mod.meta?.id || typeof mod.apply !== 'function' || typeof mod.mergeToStage !== 'function') {
      console.warn(`[adapters] skipping ${file}: must export { meta: { id, description }, apply(), mergeToStage() }`);
      continue;
    }
    if (adapters.has(mod.meta.id)) {
      throw new Error(`[adapters] duplicate adapter id "${mod.meta.id}" (${file})`);
    }
    adapters.set(mod.meta.id, mod);
  }
  cache = adapters;
  return cache;
}

export async function listAdapterMeta() {
  return [...(await loadAll()).values()].map((a) => a.meta);
}

export async function getAdapter(adapterId) {
  if (!adapterId) return null;
  return (await loadAll()).get(adapterId) || null;
}
