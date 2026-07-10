import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Auto-discovers every generator module in this directory — identical
// pattern to server/agents/registry.js. Adding a new action type is a
// one-file operation: drop `server/generators/<id>.js` exporting
// {meta, generate} and it is immediately listed and runnable; nothing here
// needs editing.

const HERE = dirname(fileURLToPath(import.meta.url));
const NON_GENERATOR_FILES = new Set(['types.js', 'registry.js']);

let cache = null;

async function loadAll() {
  if (cache) return cache;
  const files = readdirSync(HERE).filter((f) => f.endsWith('.js') && !NON_GENERATOR_FILES.has(f));

  const generators = new Map();
  for (const file of files) {
    const mod = await import(pathToFileURL(join(HERE, file)).href);
    if (!mod.meta?.id || typeof mod.generate !== 'function') {
      console.warn(`[generators] skipping ${file}: must export { meta: { id, ... }, generate() }`);
      continue;
    }
    if (generators.has(mod.meta.id)) {
      throw new Error(`[generators] duplicate generator id "${mod.meta.id}" (${file})`);
    }
    generators.set(mod.meta.id, mod);
  }
  cache = generators;
  return generators;
}

export async function listGeneratorMeta() {
  return [...(await loadAll()).values()].map((g) => g.meta);
}

export async function getGenerator(id) {
  return (await loadAll()).get(id) || null;
}
