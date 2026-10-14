import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// Stubbed rather than toggling process.env.DATAFORSEO_LOGIN/PASSWORD
// directly: node:test runs test files concurrently in one process, and a
// real env var is global process state — a prior run of this exact approach
// leaked 'configured' into unrelated, concurrently-running suites that
// assume DataForSEO is unconfigured by default (confirmed: intermittent
// failures in keyword-growth pipeline tests only under the full `npm test`
// run, never in isolation). mock.module scopes the stub to this file's own
// module graph instead.
const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../../ingest/dataforseo-keywords.js'), {
  namedExports: { configured: () => true, fetchKeywordIdeas: async () => [] },
});

const { evaluateLocationServiceGap, GAP_CLASS } = await import('./location-service-gap.js');

// Two DELIBERATELY unrelated tenants (different business, different service
// ids, different location ids, different country) — proves the resolver has
// no hardcoded knowledge of Zunkiree's own cities/services, only ever reads
// what each site's own data file says.

const zunkireeLocations = `export default [
  {
    id: "kathmandu",
    name: "Kathmandu",
    isHeadquarters: true,
    nearbyCities: ["pokhara"],
    services: {
      "ai-development": { title: "AI Development Services in Kathmandu", description: "..." }
    }
  },
  {
    id: "pokhara",
    name: "Pokhara",
    isHeadquarters: false,
    nearbyCities: ["kathmandu"]
  },
  {
    id: "biratnagar",
    name: "Biratnagar",
    isHeadquarters: false,
    nearbyCities: []
  }
];
`;

const plumbingLocations = `export default [
  {
    id: "austin",
    name: "Austin",
    isHeadquarters: true,
    nearbyCities: ["round-rock"],
    services: {
      "drain-cleaning": { title: "Drain Cleaning in Austin", description: "..." }
    }
  },
  {
    id: "round-rock",
    name: "Round Rock",
    isHeadquarters: false,
    nearbyCities: ["austin"]
  },
  {
    id: "dallas",
    name: "Dallas",
    isHeadquarters: false,
    nearbyCities: []
  }
];
`;

const zunkireeConfig = { id: 'data-array-content', format: 'js-export-array', dataFile: 'src/_data/locations.js', idField: 'id', nestedField: 'services' };
const plumbingConfig = { id: 'data-array-content', format: 'js-export-array', dataFile: 'src/_data/locations.js', idField: 'id', nestedField: 'services' };

function fetcherFor(content) {
  return async () => ({ content });
}

const withDemand = async () => [{ keyword: 'x', searchVolume: 320 }];
const noDemand = async () => [];

describe('evaluateLocationServiceGap', () => {
  test('tenant A: nearby-linked location + known offering + real demand -> SAFE_RECOVERY', async () => {
    const r = await evaluateLocationServiceGap(
      { id: 1 },
      'https://zunkireelabs.com/locations/pokhara/ai-development/',
      zunkireeConfig,
      { fetchFile: fetcherFor(zunkireeLocations), fetchIdeas: withDemand }
    );
    assert.equal(r.verdict, GAP_CLASS.SAFE_RECOVERY);
    assert.equal(r.evidence.locationId, 'pokhara');
    assert.equal(r.evidence.serviceId, 'ai-development');
  });

  test('tenant B: distinct vertical (plumbing), distinct ids -> SAFE_RECOVERY, proves no hardcoding', async () => {
    const r = await evaluateLocationServiceGap(
      { id: 2 },
      'https://acmeplumbing.com/locations/round-rock/drain-cleaning/',
      plumbingConfig,
      { fetchFile: fetcherFor(plumbingLocations), fetchIdeas: withDemand }
    );
    assert.equal(r.verdict, GAP_CLASS.SAFE_RECOVERY);
    assert.equal(r.evidence.locationId, 'round-rock');
    assert.equal(r.evidence.serviceId, 'drain-cleaning');
  });

  test('location not linked to any serviced location and not headquarters -> INSUFFICIENT_DATA', async () => {
    const r = await evaluateLocationServiceGap(
      { id: 1 },
      'https://zunkireelabs.com/locations/biratnagar/ai-development/',
      zunkireeConfig,
      { fetchFile: fetcherFor(zunkireeLocations), fetchIdeas: withDemand }
    );
    assert.equal(r.verdict, GAP_CLASS.INSUFFICIENT_DATA);
    assert.equal(r.reason, 'location-not-a-declared-expansion-target');
  });

  test('service never offered anywhere in the file -> INSUFFICIENT_DATA, never invents a new service', async () => {
    const r = await evaluateLocationServiceGap(
      { id: 1 },
      'https://zunkireelabs.com/locations/pokhara/quantum-computing/',
      zunkireeConfig,
      { fetchFile: fetcherFor(zunkireeLocations), fetchIdeas: withDemand }
    );
    assert.equal(r.verdict, GAP_CLASS.INSUFFICIENT_DATA);
    assert.equal(r.reason, 'service-not-a-known-offering');
  });

  test('no real search demand -> INSUFFICIENT_DATA, does not fabricate demand', async () => {
    const r = await evaluateLocationServiceGap(
      { id: 1 },
      'https://zunkireelabs.com/locations/pokhara/ai-development/',
      zunkireeConfig,
      { fetchFile: fetcherFor(zunkireeLocations), fetchIdeas: noDemand }
    );
    assert.equal(r.verdict, GAP_CLASS.INSUFFICIENT_DATA);
    assert.equal(r.reason, 'no-verified-search-demand');
  });

  test('location entry does not exist at all -> INSUFFICIENT_DATA, never invents a new location', async () => {
    const r = await evaluateLocationServiceGap(
      { id: 1 },
      'https://zunkireelabs.com/locations/chitwan/ai-development/',
      zunkireeConfig,
      { fetchFile: fetcherFor(zunkireeLocations), fetchIdeas: withDemand }
    );
    assert.equal(r.verdict, GAP_CLASS.INSUFFICIENT_DATA);
    assert.equal(r.reason, 'location-entry-does-not-exist');
  });

  test('entry already exists -> INSUFFICIENT_DATA (nothing to recover)', async () => {
    const r = await evaluateLocationServiceGap(
      { id: 1 },
      'https://zunkireelabs.com/locations/kathmandu/ai-development/',
      zunkireeConfig,
      { fetchFile: fetcherFor(zunkireeLocations), fetchIdeas: withDemand }
    );
    assert.equal(r.verdict, GAP_CLASS.INSUFFICIENT_DATA);
    assert.equal(r.reason, 'already-exists');
  });
});
