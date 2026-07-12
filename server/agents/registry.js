import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Auto-discovers every agent module in this directory. Adding a new agent is
// a one-file operation — drop `server/agents/<id>.js` exporting {meta, run}
// and it is immediately listed and runnable; nothing here needs editing.

const HERE = dirname(fileURLToPath(import.meta.url));
const NON_AGENT_FILES = new Set(['types.js', 'registry.js', 'runner.js', 'orchestrator.js']);

let cache = null;

async function loadAll() {
  if (cache) return cache;
  const files = readdirSync(HERE).filter((f) => f.endsWith('.js') && !NON_AGENT_FILES.has(f));

  const agents = new Map();
  for (const file of files) {
    const mod = await import(pathToFileURL(join(HERE, file)).href);
    if (!mod.meta?.id || typeof mod.run !== 'function') {
      console.warn(`[agents] skipping ${file}: must export { meta: { id, ... }, run() }`);
      continue;
    }
    if (agents.has(mod.meta.id)) {
      throw new Error(`[agents] duplicate agent id "${mod.meta.id}" (${file})`);
    }
    agents.set(mod.meta.id, mod);
  }
  cache = agents;
  return agents;
}

export async function listAgentMeta() {
  return [...(await loadAll()).values()].map((a) => a.meta);
}

export async function getAgent(id) {
  return (await loadAll()).get(id) || null;
}
