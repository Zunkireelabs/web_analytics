import { nullSearchDemandProvider } from './null.js';

// Single seam every caller goes through — never import null.js or a future
// real provider directly outside this file. Same registration pattern as
// server/ingest/competitor-providers (a `PROVIDERS` env var selecting an
// implementation), sized down to one provider today because there is
// nothing to choose between yet.
//
// TO ACTIVATE A REAL PROVIDER LATER: implement provider.js's
// SearchDemandProvider contract in a new file (e.g. dataforseo-trends.js),
// import it here, and return it from getSearchDemandProvider() when its
// configured() is true — falling back to the null provider otherwise so an
// unset/invalid key degrades to "unavailable", never to a crash or a silent
// wrong number. Nothing in analyst-fusion.js, the scoring, or the
// recommendation narrative needs to change: they already read
// `signal.available` and branch on it.
const PROVIDERS = [
  // Future: realDataForSeoTrendsProvider,
];

export function getSearchDemandProvider() {
  const active = PROVIDERS.find((p) => p.configured());
  return active || nullSearchDemandProvider;
}
