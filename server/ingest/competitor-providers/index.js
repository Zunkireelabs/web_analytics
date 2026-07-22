import * as dataforseo from './dataforseo.js';
import * as googleCse from './google-cse.js';

// Every registered provider, keyed by its own `id`. Adding a new one is a
// one-line addition here plus one new adapter file — see ./types.js.
const PROVIDERS = { [dataforseo.id]: dataforseo, [googleCse.id]: googleCse };

// COMPETITOR_PROVIDER lets a future multi-provider setup switch without a
// code change; defaults to DataForSEO (the current chosen provider).
export function getCompetitorProvider(id = process.env.COMPETITOR_PROVIDER || 'dataforseo') {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unknown competitor provider "${id}" — registered: ${Object.keys(PROVIDERS).join(', ')}`);
  return provider;
}

// Whether the currently-selected provider is ready to serve real data — the
// one place every caller checks instead of hardcoding a DataForSEO-specific
// env check, so switching providers (or adding a third) never means hunting
// down scattered credential checks across job.js/competitor-analysis.js/
// competitor-intelligence.js.
export function competitorProviderConfigured() {
  return getCompetitorProvider().configured();
}
