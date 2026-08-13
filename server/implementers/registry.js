import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Auto-discovers every implementer module in this directory — identical
// pattern to server/generators/registry.js and server/agents/registry.js.
// Adding a new domain split (e.g. an "i18n" implementer) is a one-file
// operation: drop `server/implementers/<id>.js` exporting
// {meta: {id, handles}, apply(), mergeToStage()} and its generator ids are
// immediately routed to it; nothing here needs editing. `apply()` pushes a
// real branch (one per site per calendar day, forked from — and kept in
// sync with — the site's default branch); `mergeToStage()` (despite the
// name) never touches a stage branch at all — it opens a real PR against
// that same default branch (see server/implementers/lib/github-ops.js's
// openPrForBranch). Merging is always a human, on GitHub itself; this app
// never auto-merges anything onto production.

const HERE = dirname(fileURLToPath(import.meta.url));
const NON_IMPLEMENTER_FILES = new Set(['types.js', 'registry.js', 'resolve.js']);

let cache = null;

async function loadAll() {
  if (cache) return cache;
  // The `.test.js` exclusion is not cosmetic: without it this readdir picks
  // up frontend.test.js, and the `await import()` below EXECUTES it — running
  // a node:test suite inside the production server process on the first
  // draft apply/preview. The skip-warning further down only fires after that
  // import already ran. Matches agents/registry.js, generators/registry.js
  // and adapters/registry.js, which all already filter this way.
  const files = readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && !NON_IMPLEMENTER_FILES.has(f));

  const implementers = new Map();
  const byGeneratorId = new Map();
  for (const file of files) {
    const mod = await import(pathToFileURL(join(HERE, file)).href);
    if (!mod.meta?.id || !Array.isArray(mod.meta.handles) || typeof mod.apply !== 'function' || typeof mod.mergeToStage !== 'function') {
      console.warn(`[implementers] skipping ${file}: must export { meta: { id, handles: [] }, apply(), mergeToStage() }`);
      continue;
    }
    if (implementers.has(mod.meta.id)) {
      throw new Error(`[implementers] duplicate implementer id "${mod.meta.id}" (${file})`);
    }
    implementers.set(mod.meta.id, mod);
    for (const generatorId of mod.meta.handles) {
      if (byGeneratorId.has(generatorId)) {
        throw new Error(`[implementers] generator id "${generatorId}" claimed by both "${byGeneratorId.get(generatorId)}" and "${mod.meta.id}"`);
      }
      byGeneratorId.set(generatorId, mod);
    }
  }
  cache = { implementers, byGeneratorId };
  return cache;
}

export async function listImplementerMeta() {
  return [...(await loadAll()).implementers.values()].map((i) => i.meta);
}

export async function getImplementerForGenerator(generatorId) {
  return (await loadAll()).byGeneratorId.get(generatorId) || null;
}
