import * as dataforseo from './dataforseo.js';

// Every registered provider, keyed by its own `id`. Adding a new one is a
// one-line addition here plus one new adapter file — see ./types.js.
const PROVIDERS = { [dataforseo.id]: dataforseo };

// COMPETITOR_PROVIDER lets a future multi-provider setup switch without a
// code change; defaults to DataForSEO (the current chosen provider).
export function getCompetitorProvider(id = process.env.COMPETITOR_PROVIDER || 'dataforseo') {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unknown competitor provider "${id}" — registered: ${Object.keys(PROVIDERS).join(', ')}`);
  return provider;
}
