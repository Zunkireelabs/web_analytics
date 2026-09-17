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
  const files = readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && !NON_GENERATOR_FILES.has(f));

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
  if (cache) return cache.get(id) || null;
  // Fast path: most callers ask for exactly one generator by its own id,
  // which is its own file's basename (this registry's "adding a new action
  // type is a one-file operation" convention) — importing just that file
  // avoids dragging in every OTHER generator's dependency graph (LLM
  // clients, etc.) just to answer "does generator X exist", which matters
  // both for hot-path cost and because a caller that only ever asks for one
  // or two specific ids (e.g. the verification layer) shouldn't force every
  // generator module in the directory to load successfully. Falls back to
  // the full directory scan (which also performs the duplicate-id check)
  // only when the fast path can't resolve a valid module — e.g. an id that
  // doesn't map 1:1 to a filename, if that convention is ever broken.
  if (!NON_GENERATOR_FILES.has(`${id}.js`)) {
    try {
      const mod = await import(pathToFileURL(join(HERE, `${id}.js`)).href);
      if (mod.meta?.id === id && typeof mod.generate === 'function') return mod;
    } catch { /* fall through to the full scan below */ }
  }
  return (await loadAll()).get(id) || null;
}
