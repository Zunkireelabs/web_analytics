// The always-unavailable provider — what the Analyst runs on until a real
// external search-demand API key is supplied. Implements the same
// SearchDemandProvider contract (provider.js) a future real adapter will, so
// swapping one in later is a registration change (registry.js), not a
// rewrite of anything that calls this.
//
// Never fabricates. Every signal returned has `available: false` and a
// `note` explaining why — analyst-fusion.js writes this straight into
// analyst_evidence.external_demand, so a stored conclusion is permanent,
// honest proof that no external volume data informed it.
const UNAVAILABLE_NOTE = 'No external search-demand provider is configured. Using first-party GSC data only.';

function unavailableSignal() {
  return {
    available: false,
    providerId: 'null',
    searchVolume: null,
    volumeTrend: null,
    volumeTrendPct: null,
    relatedQueries: [],
    emergingTopics: [],
    asOf: null,
    note: UNAVAILABLE_NOTE,
  };
}

export const nullSearchDemandProvider = {
  id: 'null',
  configured: () => false,
  async fetchDemand(_topic) {
    return unavailableSignal();
  },
  async fetchDemandBulk(topics) {
    const out = new Map();
    for (const t of topics || []) out.set(t, unavailableSignal());
    return out;
  },
};
