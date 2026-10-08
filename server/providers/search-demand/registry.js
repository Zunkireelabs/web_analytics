import { nullSearchDemandProvider } from './null.js';
import { dataForSeoSearchDemandProvider } from './dataforseo.js';

// Single seam every caller goes through — never import null.js or a real
// provider directly outside this file. Same registration pattern as
// server/ingest/competitor-providers (a `PROVIDERS` env var selecting an
// implementation).
//
// Each provider's own configured() decides whether it is eligible, and the
// null provider is the fallback — so an unset or invalid key degrades to
// "unavailable", never to a crash or a silent wrong number. Nothing in
// analyst-fusion.js, the scoring, or the recommendation narrative needs to
// change when one activates: they already read `signal.available` and
// branch on it.
//
// dataforseo requires SEARCH_DEMAND_PROVIDER=dataforseo in addition to its
// credentials, because every call it makes is billed and it is reachable
// from cron for every tenant — see its own header. Credentials for the SERP
// and backlinks adapters must not switch this on by themselves.
const PROVIDERS = [
  dataForSeoSearchDemandProvider,
];

export function getSearchDemandProvider() {
  const active = PROVIDERS.find((p) => p.configured());
  return active || nullSearchDemandProvider;
}
