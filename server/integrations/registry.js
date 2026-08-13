import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Auto-discovers every integration module in this directory — mirrors
// server/agents/registry.js exactly. Adding a new tracked integration
// (Google Search Console, GA4, Docs, DataForSEO, OpenAI, Anthropic, email,
// ...) is a one-file operation: drop `server/integrations/<id>.js` exporting
// { meta, check() } and it's immediately listed and checkable; nothing here
// needs editing.

const HERE = dirname(fileURLToPath(import.meta.url));
const NON_INTEGRATION_FILES = new Set(['registry.js']);

let cache = null;

async function loadAll() {
  if (cache) return cache;
  const files = readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && !NON_INTEGRATION_FILES.has(f));

  const integrations = new Map();
  for (const file of files) {
    const mod = await import(pathToFileURL(join(HERE, file)).href);
    if (!mod.meta?.id || typeof mod.check !== 'function') {
      console.warn(`[integrations] skipping ${file}: must export { meta: { id, ... }, check() }`);
      continue;
    }
    if (integrations.has(mod.meta.id)) {
      throw new Error(`[integrations] duplicate integration id "${mod.meta.id}" (${file})`);
    }
    integrations.set(mod.meta.id, mod);
  }
  cache = integrations;
  return integrations;
}

export async function listIntegrationMeta() {
  return [...(await loadAll()).values()].map((i) => i.meta);
}

export async function getIntegration(id) {
  return (await loadAll()).get(id) || null;
}
