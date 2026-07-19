import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Auto-discovers every implementer module in this directory — identical
// pattern to server/generators/registry.js and server/agents/registry.js.
// Adding a new domain split (e.g. an "i18n" implementer) is a one-file
// operation: drop `server/implementers/<id>.js` exporting
// {meta: {id, handles}, apply(), mergeToStage()} and its generator ids are
// immediately routed to it; nothing here needs editing. `apply()` pushes a
// real branch (forked from stage) with the real change; `mergeToStage()`
// merges that already-pushed branch directly into stage (no PR — see
// server/implementers/lib/github-ops.js and
// ~/Travel/ci-cd-deployment-master-guide for why stage doesn't need one).

const HERE = dirname(fileURLToPath(import.meta.url));
const NON_IMPLEMENTER_FILES = new Set(['types.js', 'registry.js', 'resolve.js']);

let cache = null;

async function loadAll() {
  if (cache) return cache;
  const files = readdirSync(HERE).filter((f) => f.endsWith('.js') && !NON_IMPLEMENTER_FILES.has(f));

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
