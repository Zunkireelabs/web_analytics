import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSerp, parseSerpApi, fetchSerp, fetchSerps, serpKey, countryFor, serpConfigured, SERP_ENDPOINT } from './serp.js';

// A trimmed real-shaped DataForSEO organic/live/advanced response.
const body = (items) => ({ tasks: [{ status_code: 20000, result: [{ items }] }] });
const organic = (rank, url, extra = {}) => ({ type: 'organic', rank_absolute: rank, url, domain: new URL(url).hostname, title: `Result ${rank}`, description: `About ${rank}`, ...extra });
const SAMPLE = body([
  { type: 'featured_snippet', rank_absolute: 1 },
  organic(2, 'https://www.alpha.example/guide'), organic(1, 'https://beta.example/post'), organic(3, 'https://gamma.example/'),
  { type: 'paid', rank_absolute: 1 },
  { type: 'people_also_ask', items: [{ title: 'What is a CRM?' }, { title: 'Is a CRM worth it?' }] },
  { type: 'people_also_ask', items: [{ title: 'What is a CRM?' }] },
  { type: 'related_searches', items: ['crm for small business', 'free crm'] },
  { type: 'video', rank_absolute: 5 },
  { type: 'organic', url: 'https://no-rank.example/', rank_absolute: null },
]);

describe('parseSerp', () => {
  test('organic results in rank order, www stripped; paid and rank-less items left out', () => {
    const r = parseSerp(SAMPLE);
    assert.deepEqual(r.results.map((x) => [x.position, x.domain]), [[1, 'beta.example'], [2, 'alpha.example'], [3, 'gamma.example']]);
    assert.equal(r.results[0].title, 'Result 1');
  });
  test('People Also Ask de-duplicated; related searches; features exclude organic, paid, PAA and related', () => {
    const r = parseSerp(SAMPLE);
    assert.deepEqual(r.peopleAlsoAsk, ['What is a CRM?', 'Is a CRM worth it?']);
    assert.deepEqual(r.relatedSearches, ['crm for small business', 'free crm']);
    assert.deepEqual(r.features, ['featured_snippet', 'video']);
  });
  test('capped at 10 results; an empty or odd body gives empty parts, never a throw', () => {
    assert.equal(parseSerp(body(Array.from({ length: 15 }, (_, i) => organic(i + 1, `https://s${i}.example/`)))).results.length, 10);
    assert.deepEqual(parseSerp(null), { results: [], peopleAlsoAsk: [], relatedSearches: [], features: [] });
    assert.deepEqual(parseSerp({ tasks: [] }).results, []);
  });
});

describe('fetchSerp', () => {
  const mk = (over = {}) => {
    const calls = []; const writes = [];
    return {
      calls, writes,
      deps: {
        // SerpApi is off unless a test turns it on: a developer's SERPAPI_KEY in .env must never spend a real search from a test.
        readCache: async () => null, writeCache: async (...a) => { writes.push(a); }, configured: () => true,
        serpApiConfigured: () => false, env: {}, fetchImpl: async () => { throw new Error('a test reached the network'); },
        call: async (args) => { calls.push(args); return { ok: true, body: SAMPLE, costUsd: 0.002 }; },
        ...over,
      },
    };
  };
  const site = { target_markets: [{ locationCode: 2826, languageCode: 'en' }] }; // a site that names its market

  test('a live lookup goes through the budgeted client with the right body, then is cached', async () => {
    const t = mk();
    const r = await fetchSerp(7, '  Best   CRM Software ', { site, deps: t.deps });
    assert.equal(r.ok, true); assert.equal(r.source, 'live'); assert.equal(r.costUsd, 0.002); assert.equal(r.results.length, 3);
    assert.deepEqual(t.calls[0], { siteId: 7, job: 'serp-research', endpoint: SERP_ENDPOINT, timeoutMs: 30000, body: [{ keyword: 'best crm software', location_code: 2826, language_code: 'en', depth: 10 }] });
    assert.deepEqual(t.writes[0].slice(0, 3), ['best crm software', 2826, 'en']);
  });
  test('a fresh cached result costs nothing and needs no credentials', async () => {
    const t = mk({ readCache: async () => ({ results: [{ position: 1, url: 'https://x.example/', domain: 'x.example' }], peopleAlsoAsk: [], relatedSearches: [], features: [] }), configured: () => false });
    const r = await fetchSerp(7, 'crm', { site, deps: t.deps });
    assert.equal(r.ok, true); assert.equal(r.source, 'cache'); assert.equal(t.calls.length, 0);
  });
  test('a site that names no market is looked up in the global default market', async () => {
    const t = mk(); await fetchSerp(7, 'crm', { site: {}, deps: t.deps });
    assert.equal(t.calls[0].body[0].location_code, 2840);
  });
  test('an explicit market overrides the site\'s', async () => {
    const t = mk(); await fetchSerp(7, 'crm', { site, locationCode: 2840, languageCode: 'es', deps: t.deps });
    assert.equal(t.calls[0].body[0].location_code, 2840); assert.equal(t.calls[0].body[0].language_code, 'es');
  });
  test('refusals: no credentials, a search operator, an empty keyword, the budget, a failed call, no results', async () => {
    assert.deepEqual(await fetchSerp(7, 'crm', { site, deps: mk({ configured: () => false }).deps }), { ok: false, reason: 'not_configured' });
    assert.deepEqual(await fetchSerp(7, 'site:example.com crm', { site, deps: mk().deps }), { ok: false, reason: 'search_operator_keyword' });
    assert.deepEqual(await fetchSerp(7, '   ', { site, deps: mk().deps }), { ok: false, reason: 'no_keyword' });
    assert.equal((await fetchSerp(7, 'crm', { site, deps: mk({ call: async () => ({ ok: false, reason: 'budget_refused' }) }).deps })).reason, 'budget_refused');
    const failed = await fetchSerp(7, 'crm', { site, deps: mk({ call: async () => ({ ok: false, reason: 'failed', error: '40501 bad' }) }).deps });
    assert.deepEqual([failed.ok, failed.reason, failed.detail], [false, 'failed', '40501 bad']);
    assert.equal((await fetchSerp(7, 'crm', { site, deps: mk({ call: async () => ({ ok: true, body: body([]) }) }).deps })).reason, 'no_serp_results');
  });
  test('a broken cache never breaks the lookup', async () => {
    const t = mk({ readCache: async () => { throw new Error('db down'); }, writeCache: async () => { throw new Error('db down'); } });
    assert.equal((await fetchSerp(7, 'crm', { site, deps: t.deps })).ok, true);
  });
});

describe('fetchSerps', () => {
  test('looks every keyword up once (de-duplicated) and reports how many were paid for', async () => {
    const calls = [];
    const deps = { readCache: async () => null, writeCache: async () => {}, configured: () => true, serpApiConfigured: () => false, env: {}, call: async (a) => { calls.push(a.body[0].keyword); return { ok: true, body: SAMPLE, costUsd: 0.002 }; } };
    const r = await fetchSerps(7, ['a', 'b', 'a', 'c'], { site: {}, deps });
    assert.deepEqual([...r.byKeyword.keys()].sort(), ['a', 'b', 'c']);
    assert.equal(r.liveCalls, 3); assert.equal(calls.length, 3); assert.equal(r.stoppedEarly, null);
  });
  test('after the budget is refused no more paid calls are made, but cached keywords are still served', async () => {
    let n = 0;
    const deps = {
      readCache: async (key) => (key === 'cached one' ? { results: [{ position: 1, url: 'https://c.example/', domain: 'c.example' }], peopleAlsoAsk: [], relatedSearches: [], features: [] } : null),
      writeCache: async () => {}, configured: () => true, serpApiConfigured: () => false, env: {},
      call: async () => { n += 1; return { ok: false, reason: 'budget_refused' }; },
    };
    const r = await fetchSerps(7, ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'], { site: {}, concurrency: 1, deps });
    assert.equal(n, 1, 'only the first call reached the provider');
    assert.equal(r.stoppedEarly, 'budget_refused');
    assert.ok([...r.byKeyword.values()].every((v) => v.reason === 'budget_refused'));
    const r2 = await fetchSerps(7, ['cached one', 'k9'], { site: {}, concurrency: 1, deps });
    assert.equal(r2.byKeyword.get('cached one').source, 'cache');
  });
});

test('serpKey normalizes', () => assert.equal(serpKey('  Hello   WORLD '), 'hello world'));

// ── SerpApi: the second provider ─────────────────────────────────────────────────────────────────────────────────────────────────────
const apiBody = (over = {}) => ({
  organic_results: [{ position: 2, link: 'https://www.alpha.example/guide', title: 'Alpha guide', snippet: 'About alpha' }, { position: 1, link: 'https://beta.example/post', title: 'Beta post', snippet: 'About beta' }, { position: null, link: 'https://x.example/' }],
  related_questions: [{ question: 'What is a CRM?' }, { question: 'Is a CRM worth it?' }, { question: 'What is a CRM?' }],
  related_searches: [{ query: 'free crm' }, { query: 'crm for small business' }],
  answer_box: { type: 'organic_result' }, inline_videos: [{ title: 'v' }], ...over,
});

describe('parseSerpApi', () => {
  test('organic results in rank order, www stripped; questions de-duplicated; features from the blocks present', () => {
    const r = parseSerpApi(apiBody());
    assert.deepEqual(r.results.map((x) => [x.position, x.domain, x.title]), [[1, 'beta.example', 'Beta post'], [2, 'alpha.example', 'Alpha guide']]);
    assert.equal(r.results[0].description, 'About beta');
    assert.deepEqual(r.peopleAlsoAsk, ['What is a CRM?', 'Is a CRM worth it?']);
    assert.deepEqual(r.relatedSearches, ['free crm', 'crm for small business']);
    assert.deepEqual(r.features, ['featured_snippet', 'video']);
  });
  test('an empty or odd body gives empty parts, never a throw; capped at 10', () => {
    assert.deepEqual(parseSerpApi(null), { results: [], peopleAlsoAsk: [], relatedSearches: [], features: [] });
    assert.equal(parseSerpApi({ organic_results: Array.from({ length: 15 }, (_, i) => ({ position: i + 1, link: `https://s${i}.example/` })) }).results.length, 10);
  });
});

describe('countryFor', () => {
  test('known DataForSEO markets map to SerpApi countries; an unknown one uses SERPAPI_COUNTRY, else us', () => {
    assert.deepEqual([2840, 2826, 2524, 2276].map((c) => countryFor(c, {})), ['us', 'gb', 'np', 'de']);
    assert.equal(countryFor(99999, { SERPAPI_COUNTRY: 'AU' }), 'au');
    assert.equal(countryFor(99999, {}), 'us');
  });
});

describe('provider choice', () => {
  const site = { target_markets: [{ locationCode: 2826, languageCode: 'en' }] };
  const mkApi = ({ dfs = true, api = true, env = {}, dfsCall, apiResponse } = {}) => {
    const dfsCalls = []; const apiCalls = []; const writes = [];
    return {
      dfsCalls, apiCalls, writes,
      deps: {
        readCache: async () => null, writeCache: async (...a) => { writes.push(a); },
        configured: () => dfs, serpApiConfigured: () => api, env,
        call: dfsCall || (async (a) => { dfsCalls.push(a); return { ok: true, body: SAMPLE, costUsd: 0.002 }; }),
        fetchImpl: async (url, init) => { apiCalls.push(String(url)); const r = apiResponse || { status: 200, body: apiBody() }; return { ok: r.status === 200, status: r.status, json: async () => r.body }; },
      },
    };
  };

  test('with both configured, DataForSEO is used and SerpApi is not touched', async () => {
    const t = mkApi(); const r = await fetchSerp(1, 'crm', { site, deps: t.deps });
    assert.equal(r.provider, 'dataforseo'); assert.equal(t.dfsCalls.length, 1); assert.equal(t.apiCalls.length, 0);
  });

  test('DataForSEO failing (no credit, an outage) falls back to SerpApi, and the result is cached', async () => {
    const t = mkApi({ dfsCall: async () => ({ ok: false, reason: 'failed', error: '40200 payment required' }) });
    const r = await fetchSerp(1, 'best crm', { site, deps: t.deps });
    assert.equal(r.ok, true); assert.equal(r.provider, 'serpapi'); assert.equal(r.source, 'live');
    assert.equal(r.results[0].domain, 'beta.example');
    assert.equal(t.writes.length, 1);
    const url = new URL(t.apiCalls[0]);
    assert.equal(url.origin + url.pathname, 'https://serpapi.com/search.json');
    assert.equal(url.searchParams.get('q'), 'best crm'); assert.equal(url.searchParams.get('gl'), 'gb'); assert.equal(url.searchParams.get('hl'), 'en'); assert.equal(url.searchParams.get('engine'), 'google');
  });

  test('DataForSEO not configured: SerpApi is used straight away', async () => {
    const t = mkApi({ dfs: false }); const r = await fetchSerp(1, 'crm', { site, deps: t.deps });
    assert.equal(r.provider, 'serpapi'); assert.equal(t.dfsCalls.length, 0);
  });

  test('a monthly-budget refusal is the project\'s own cap: it is NOT routed around by switching to SerpApi', async () => {
    const t = mkApi({ dfsCall: async () => ({ ok: false, reason: 'budget_refused' }) });
    const r = await fetchSerp(1, 'crm', { site, deps: t.deps });
    assert.deepEqual(r, { ok: false, reason: 'budget_refused' }); assert.equal(t.apiCalls.length, 0);
  });

  test('SERP_PROVIDER=serpapi skips DataForSEO entirely; SERP_PROVIDER=dataforseo never uses SerpApi', async () => {
    const only = mkApi({ env: { SERP_PROVIDER: 'serpapi' } });
    assert.equal((await fetchSerp(1, 'crm', { site, deps: only.deps })).provider, 'serpapi'); assert.equal(only.dfsCalls.length, 0);
    const dfsOnly = mkApi({ env: { SERP_PROVIDER: 'dataforseo' }, dfsCall: async () => ({ ok: false, reason: 'failed', error: 'down' }) });
    const r = await fetchSerp(1, 'crm', { site, deps: dfsOnly.deps });
    assert.equal(r.ok, false); assert.equal(r.reason, 'failed'); assert.equal(dfsOnly.apiCalls.length, 0);
  });

  test('neither provider configured, or the chosen one not configured: not_configured', async () => {
    assert.equal((await fetchSerp(1, 'crm', { site, deps: mkApi({ dfs: false, api: false }).deps })).reason, 'not_configured');
    assert.equal((await fetchSerp(1, 'crm', { site, deps: mkApi({ dfs: false, api: true, env: { SERP_PROVIDER: 'dataforseo' } }).deps })).reason, 'not_configured');
  });

  test('SerpApi errors: an API error, an HTTP failure and a network failure are results, not throws; an empty results page is "no_serp_results"', async () => {
    const run = (apiResponse, fetchImpl) => { const t = mkApi({ dfs: false, apiResponse }); if (fetchImpl) t.deps.fetchImpl = fetchImpl; return fetchSerp(1, 'crm', { site, deps: t.deps }); };
    const bad = await run({ status: 200, body: { error: 'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key' } });
    assert.deepEqual([bad.ok, bad.reason], [false, 'failed']);
    assert.equal((await run({ status: 429, body: { error: 'Your account has run out of searches.' } })).reason, 'failed');
    assert.equal((await run({ status: 200, body: { error: "Google hasn't returned any results for this query." } })).reason, 'no_serp_results');
    assert.equal((await run({ status: 200, body: { organic_results: [] } })).reason, 'no_serp_results');
    const down = await run(null, async () => { throw new Error('ECONNRESET'); });
    assert.deepEqual([down.ok, down.reason, down.detail], [false, 'failed', 'could not reach SerpApi']);
  });

  test('the key never appears in an error', async () => {
    const t = mkApi({ dfs: false, env: { SERPAPI_KEY: 'sk-secret-123' }, apiResponse: { status: 200, body: { error: 'Invalid API key' } } });
    assert.doesNotMatch(JSON.stringify(await fetchSerp(1, 'crm', { site, deps: t.deps })), /sk-secret/);
  });
});

test('serpConfigured is true when either provider has credentials', () => {
  assert.equal(serpConfigured({}), false);
  assert.equal(serpConfigured({ SERPAPI_KEY: 'k' }), true);
  assert.equal(serpConfigured({ DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' }), true);
  assert.equal(serpConfigured({ DATAFORSEO_LOGIN: 'a' }), false);
});

// ── A REAL SerpApi response (trimmed, redacted): Google sent redirect links for 7 of 8 organic results ──────────────────────────────────
import { readFileSync } from 'node:fs';
import { overlapScore } from './serp-overlap.js';
import { classifyResultType } from '../agents/lib/sxo.js';
const REAL = JSON.parse(readFileSync(new URL('./fixtures/serpapi-redirect-links.json', import.meta.url), 'utf8'));

describe('parseSerpApi on a real response whose links are Google redirects', () => {
  const r = parseSerpApi(REAL);

  test('no result is attributed to google.com: each keeps its real domain, from displayed_link', () => {
    assert.equal(r.results.length, 8);
    assert.ok(!r.results.some((x) => /google\./.test(x.domain)), 'a redirect must never make google.com the domain');
    assert.deepEqual(r.results.map((x) => x.domain), ['reddit.com', 'slack.com', 'uschamber.com', 'zoho.com', 'forbes.com', 'g2.com', 'salesforce.com', 'pcmag.com']);
  });

  test('a direct link is kept as it is; a redirect result is marked approximate and never carries the redirect URL', () => {
    assert.equal(r.results[0].urlApproximate, undefined);
    assert.match(r.results[0].url, /^https:\/\/www\.reddit\.com\/r\/CRMSoftware\//);
    for (const x of r.results.slice(1)) { assert.equal(x.urlApproximate, true); assert.ok(!/google\.com/.test(x.url)); assert.match(x.matchKey, /^https:\/\/[a-z0-9.-]+\/[a-z0-9-]+$/); }
  });

  test('the rebuilt url keeps the breadcrumb as a type hint (cut-off "..." and elided segments removed); the title makes the match key', () => {
    const slack = r.results[1];
    assert.equal(slack.url, 'https://slack.com/blog/best-crm-for-small-business');
    assert.equal(slack.matchKey, 'https://slack.com/best-crm-for-small-business-in-2026');
    assert.equal(r.results[3].url, 'https://zoho.com/crm/small-business-crm-soft', 'a cut-off segment loses its trailing ...');
    assert.equal(r.results[7].url, 'https://pcmag.com/CRM-Software', 'an elided "..." segment is dropped');
  });

  test('the same page in two different searches has the same match key even though Google\'s redirect token differs, so it counts as shared', () => {
    const other = JSON.parse(JSON.stringify(REAL));
    other.organic_results.forEach((x) => { if (/goto/.test(x.link)) x.link = `https://www.google.com/goto?url=DIFFERENT-TOKEN-${x.position}`; });
    const again = parseSerpApi(other);
    assert.equal(overlapScore(r.results.map((x) => x.matchKey || x.url), again.results.map((x) => x.matchKey || x.url)), 8);
    assert.equal(overlapScore(r.results.map((x) => x.url), again.results.map((x) => x.url)), 8, 'the breadcrumb url is stable too');
  });

  test('a different page on the same site is NOT counted as shared', () => {
    const other = JSON.parse(JSON.stringify(REAL));
    other.organic_results[1].title = 'A completely different Slack article';
    const again = parseSerpApi(other);
    assert.equal(overlapScore(r.results.map((x) => x.matchKey || x.url), again.results.map((x) => x.matchKey || x.url)), 7);
  });

  test('a redirect with no readable host is dropped rather than attributed to google.com', () => {
    const odd = { organic_results: [{ position: 1, link: 'https://www.google.com/goto?url=x', displayed_link: '50+ comments', title: 'Nope' }, { position: 2, link: 'https://www.a.example/p', title: 'Real' }] };
    assert.deepEqual(parseSerpApi(odd).results.map((x) => x.domain), ['a.example']);
  });

  test('questions, related searches and features still come through', () => {
    assert.equal(r.peopleAlsoAsk.length, 4); assert.equal(r.relatedSearches.length, 8); assert.deepEqual(r.features, ['ai_overview', 'video']);
  });

  test('the rebuilt breadcrumb URL still lets the SXO classifier see a blog or a guide', () => {
    assert.equal(classifyResultType(r.results[1]), 'article');
  });
});
