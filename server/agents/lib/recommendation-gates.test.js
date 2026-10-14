import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// createRecommendationGates pulls in a long chain of real modules (github
// client, design-drift, technical-seo-analysis, pagination-routes) — these
// focused tests exercise ONLY the new shared-capability-repair wiring
// (healNewContentTarget) via the module's own dependency-injection surface
// (healContentTargetFn, healFn, discoverRoutes, fetchFingerprint), the same
// pattern discover-file-mapping.test.js and discover-content-target.test.js
// already use. Everything else the module does (page-mapping healing,
// soft-404 detection, design verification) is out of scope here.
const { createRecommendationGates } = await import(resolve('./recommendation-gates.js'));

const baseSite = { id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main', url_file_map: {} };

// Neutralizes every gate this test isn't about: no pagination routes, no
// soft-404 signal, healFn is never reached (net-new content has no
// params.page to heal), and no real GitHub reads — healUnmappedPage now also
// builds a permalink index (buildPermalinkIndex) before invoking healFn, so
// even a test whose healFn ignores the tree entirely still needs a
// non-network fetchTree here or it hits the real GitHub API.
const neutralDeps = () => ({
  discoverRoutes: async () => [],
  fetchFingerprint: async () => null,
  healFn: async () => null,
  fetchTree: async () => ({ files: [], truncated: false }),
  log: { log: () => {}, warn: () => {} },
});

describe('createRecommendationGates — healNewContentTarget wiring', () => {
  test('attempts the shared repair when newContentTargets is missing, and clears the block once it succeeds', async () => {
    let healCalls = 0;
    const healContentTargetFn = async (site, actionType) => {
      healCalls++;
      return { ...site, url_file_map: { ...site.url_file_map, newContentTargets: { [actionType]: { dir: 'src/blog', extension: '.md' } } } };
    };

    const gates = createRecommendationGates(1, baseSite, { ...neutralDeps(), healContentTargetFn });
    const result = await gates.evaluate('blog-outline', { topic: 'x' });

    assert.equal(healCalls, 1);
    // A fresh site fixture also fails the SEPARATE design-verification gate
    // (no component template derived yet) — real, correct, and out of scope
    // for this test. What matters here is that the repair cleared THIS
    // gate: the reason returned must no longer be the newContentTargets one.
    assert.doesNotMatch(result.blockedReason || '', /newContentTargets/, 'the repair resolved the target, so this recommendation is no longer blocked on IT specifically');
  });

  test('keeps the original blocked reason when the repair cannot safely resolve one', async () => {
    const healContentTargetFn = async () => null; // ambiguous/not-found — never guesses
    const gates = createRecommendationGates(1, baseSite, { ...neutralDeps(), healContentTargetFn });
    const result = await gates.evaluate('blog-outline', { topic: 'x' });

    assert.match(result.blockedReason, /newContentTargets\["blog-outline"\]/);
  });

  test('attempts the repair only ONCE per actionType per pass, not once per recommendation', async () => {
    let healCalls = 0;
    const healContentTargetFn = async () => { healCalls++; return null; };
    const gates = createRecommendationGates(1, baseSite, { ...neutralDeps(), healContentTargetFn });

    await gates.evaluate('blog-outline', { topic: 'a' });
    await gates.evaluate('blog-outline', { topic: 'b' });
    await gates.evaluate('blog-outline', { topic: 'c' });

    assert.equal(healCalls, 1, 'three blog-outline recommendations in one pass must share one repair attempt');
  });

  test('a repair for one actionType does not suppress a genuinely separate actionType\'s attempt', async () => {
    const attempted = [];
    const healContentTargetFn = async (site, actionType) => { attempted.push(actionType); return null; };
    const gates = createRecommendationGates(1, baseSite, { ...neutralDeps(), healContentTargetFn });

    await gates.evaluate('blog-outline', { topic: 'a' });
    await gates.evaluate('landing-page', { topic: 'b' });

    assert.deepEqual(attempted.sort(), ['blog-outline', 'landing-page']);
  });

  test('never attempts a repair for a site with no repository configured', async () => {
    let healCalls = 0;
    const healContentTargetFn = async () => { healCalls++; return null; };
    const gates = createRecommendationGates(1, { ...baseSite, repo_owner: null, repo_name: null }, { ...neutralDeps(), healContentTargetFn });

    await gates.evaluate('blog-outline', { topic: 'a' });

    assert.equal(healCalls, 0);
  });

  test('never attempts a repair when the target already resolves', async () => {
    let healCalls = 0;
    const healContentTargetFn = async () => { healCalls++; return null; };
    const configured = { ...baseSite, url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md' } } } };
    const gates = createRecommendationGates(1, configured, { ...neutralDeps(), healContentTargetFn });

    const result = await gates.evaluate('blog-outline', { topic: 'a' });

    assert.equal(healCalls, 0);
    assert.doesNotMatch(result.blockedReason || '', /newContentTargets/, 'the target already resolved, so this gate never blocks on it — a separate design-verification gate blocking on this fresh fixture is expected and out of scope here');
  });

  test('does not touch page-gated generators — they have their own healFn path, not this one', async () => {
    let healCalls = 0;
    const healContentTargetFn = async () => { healCalls++; return null; };
    const gates = createRecommendationGates(1, baseSite, {
      ...neutralDeps(), healContentTargetFn,
      healFn: async (site, page) => ({ ...site, url_file_map: { pages: { [new URL(page).pathname]: { file: 'src/pages/x.njk' } } } }),
    });

    await gates.evaluate('meta-title', { page: 'https://x.com/about/' });

    assert.equal(healCalls, 0, 'meta-title is not a FRONTEND_ACTION_TYPE, so healNewContentTarget must never run for it');
  });
});

// A missing services.<id> entry used to be a permanent drop
// ('adapter-data-not-ready') — these cover the SAFE_RECOVERY wiring: a
// qualifying gap now gets ONE real recommendation created for it (via the
// SAME store functions/dedup key every other writer uses) and the ORIGINAL
// recommendation stays open with a real, honest blocked reason instead of
// silently vanishing as "healthy". agents/lib/location-service-gap.js's own
// evidence logic is out of scope here — this only tests that the gate wires
// its verdict correctly, via the module's `resolveGap` injection point.
describe('createRecommendationGates — location-service-bootstrap (SAFE_RECOVERY) wiring', () => {
  const nestedSite = {
    id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main',
    url_file_map: {
      patterns: [{
        match: '^/locations/([^/]+)/([^/]+)/?$',
        adapters: { 'meta-title': { id: 'data-array-content', format: 'js-export-array', dataFile: 'src/_data/locations.js', idField: 'id', nestedField: 'services', fields: { title: 'title' } } },
      }],
    },
  };
  const page = 'https://acme.com/locations/pokhara/aeo-seo/';
  // A real location with NO services entry for this service — exactly the
  // adapter-data-not-ready shape, content irrelevant beyond that (the real
  // evidence check is stubbed via resolveGap in these tests).
  const missingEntryFile = 'export default [{ id: "pokhara", name: "Pokhara" }];';

  test('SAFE_RECOVERY: creates the bootstrap recommendation once, keeps the original open with an honest reason (never drops it)', async () => {
    const inserted = [];
    const gates = createRecommendationGates(1, nestedSite, {
      ...neutralDeps(),
      fetchFile: async () => ({ content: missingEntryFile }),
      resolveGap: async () => ({ verdict: 'SAFE_RECOVERY', reason: 'test', evidence: { locationId: 'pokhara', serviceId: 'aeo-seo' } }),
      getCachedGap: async () => null,
      saveGap: async (siteId, dataFile, locationId, serviceId, verdict) => verdict,
      findOpenRec: async () => null,
      insertRec: async (siteId, payload) => { inserted.push(payload); return { id: 1 }; },
    });

    const result = await gates.evaluate('meta-title', { page });

    assert.equal(result.drop, null);
    assert.match(result.blockedReason, /hasn't been derived yet/);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].recommendationType, 'location-service-bootstrap');
    assert.equal(inserted[0].riskTier, 'safe');
    assert.equal(inserted[0].params.baseConfig.dataFile, 'src/_data/locations.js');
  });

  test('INSUFFICIENT_DATA: keeps the original drop, never creates a bootstrap recommendation', async () => {
    let insertCalls = 0;
    const gates = createRecommendationGates(1, nestedSite, {
      ...neutralDeps(),
      fetchFile: async () => ({ content: missingEntryFile }),
      resolveGap: async () => ({ verdict: 'INSUFFICIENT_DATA', reason: 'no-verified-search-demand' }),
      getCachedGap: async () => null,
      saveGap: async (siteId, dataFile, locationId, serviceId, verdict) => verdict,
      findOpenRec: async () => null,
      insertRec: async () => { insertCalls++; return { id: 1 }; },
    });

    const result = await gates.evaluate('meta-title', { page });

    assert.equal(result.drop, 'adapter-data-not-ready');
    assert.equal(insertCalls, 0);
  });

  test('does not create a duplicate recommendation when one is already open, and evaluates the gap only once per pass', async () => {
    let resolveCalls = 0;
    let insertCalls = 0;
    const gates = createRecommendationGates(1, nestedSite, {
      ...neutralDeps(),
      fetchFile: async () => ({ content: missingEntryFile }),
      resolveGap: async () => { resolveCalls++; return { verdict: 'SAFE_RECOVERY', reason: 'test', evidence: {} }; },
      getCachedGap: async () => null,
      saveGap: async (siteId, dataFile, locationId, serviceId, verdict) => verdict,
      findOpenRec: async () => ({ id: 99 }), // already exists
      insertRec: async () => { insertCalls++; return { id: 1 }; },
    });

    await gates.evaluate('meta-title', { page });
    await gates.evaluate('meta-title', { page });

    assert.equal(insertCalls, 0, 'an already-open bootstrap recommendation must not be duplicated');
    assert.equal(resolveCalls, 1, 'the same gap in one pass must not re-evaluate evidence twice');
  });

  test('a cached prior verdict is reused instead of re-evaluating evidence', async () => {
    let resolveCalls = 0;
    const gates = createRecommendationGates(1, nestedSite, {
      ...neutralDeps(),
      fetchFile: async () => ({ content: missingEntryFile }),
      resolveGap: async () => { resolveCalls++; return { verdict: 'SAFE_RECOVERY', reason: 'test', evidence: {} }; },
      getCachedGap: async () => ({ verdict: 'SAFE_RECOVERY', reason: 'cached', evidence: {} }),
      saveGap: async () => { throw new Error('must not save when already cached'); },
      findOpenRec: async () => null,
      insertRec: async (siteId, payload) => ({ id: 1 }),
    });

    const result = await gates.evaluate('meta-title', { page });

    assert.equal(resolveCalls, 0);
    assert.equal(result.drop, null);
  });
});

// The /compare/* FAQ shape: a pagination/data-array route with no per-page
// template file at all, so nothing else here can ever verify the shared
// layout genuinely renders the adapter's itemsField before a draft ships.
// This is deliberately never a 'drop' (the recommendation stays open) and
// never routed to a human — a real, named, auto-re-evaluated dependency
// that clears itself once the template ships, same daily-refresh mechanism
// every other blocked_reason here already uses.
describe('createRecommendationGates — faq template-capability gate (pagination/data-array routes)', () => {
  const compareSite = {
    id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main',
    url_file_map: {
      patterns: [{
        match: '^/compare/([^/]+)/?$',
        adapters: { faq: { id: 'data-array-content', dataFile: 'src/_data/comparisons.js', itemsField: 'faqs', templateFile: 'src/_includes/layouts/comparison.njk' } },
      }],
    },
  };
  const page = 'https://acme.com/compare/a-vs-b/';

  // The data-array entry itself DOES exist (isDataReady must pass) so these
  // tests exercise the NEW templateFile check specifically, not the
  // pre-existing adapter-data-not-ready gate above it.
  const comparisonEntryContent = 'export default [{ id: "a-vs-b", title: "A vs B" }];';

  test('blocked, not dropped, when the shared layout does not yet render the field — waiting, not asking a human', async () => {
    const gates = createRecommendationGates(1, compareSite, {
      ...neutralDeps(),
      fetchFile: async (site, path) => {
        if (path === 'src/_includes/layouts/comparison.njk') return { content: '<h2>FAQ</h2>' };
        if (path === 'src/_data/comparisons.js') return { content: comparisonEntryContent };
        return null;
      },
    });

    const result = await gates.evaluate('faq', { page });

    assert.equal(result.drop, null);
    assert.match(result.blockedReason, /waiting on a template capability/i);
    assert.match(result.blockedReason, /comparison\.njk/);
  });

  test('clears automatically once the template genuinely renders the field — no code change needed to unblock, only fresh repo state', async () => {
    const gates = createRecommendationGates(1, compareSite, {
      ...neutralDeps(),
      fetchFile: async (site, path) => {
        if (path === 'src/_includes/layouts/comparison.njk') return { content: '{% for faq in comp.faqs %}{{ faq.question }}{% endfor %}' };
        if (path === 'src/_data/comparisons.js') return { content: comparisonEntryContent };
        return null;
      },
    });

    const result = await gates.evaluate('faq', { page });

    assert.doesNotMatch(result.blockedReason || '', /template capability/i);
  });

  test('blocked with a specific reason when no templateFile is configured at all', async () => {
    const noTemplateFileSite = {
      ...compareSite,
      url_file_map: {
        patterns: [{
          match: '^/compare/([^/]+)/?$',
          adapters: { faq: { id: 'data-array-content', dataFile: 'src/_data/comparisons.js', itemsField: 'faqs' } },
        }],
      },
    };
    const gates = createRecommendationGates(1, noTemplateFileSite, {
      ...neutralDeps(),
      fetchFile: async (site, path) => (path === 'src/_data/comparisons.js' ? { content: comparisonEntryContent } : null),
    });

    const result = await gates.evaluate('faq', { page });

    assert.equal(result.drop, null);
    assert.match(result.blockedReason, /No "templateFile" is configured/);
  });

  test('does not run this check for a normal, per-page-mapped faq route', async () => {
    const normalSite = {
      id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main',
      url_file_map: { pages: { '/about/': { file: 'src/pages/about.njk' } } },
    };
    let fetchCalls = 0;
    const gates = createRecommendationGates(1, normalSite, {
      ...neutralDeps(),
      fetchFile: async () => { fetchCalls++; return { content: '<p>about page</p>' }; },
    });

    await gates.evaluate('faq', { page: 'https://acme.com/about/' });

    // The normal per-page file gate (line ~475) fetches the page's own file
    // once — the new templateFile check must never fire on top of that for
    // a route that resolveFile already resolves.
    assert.equal(fetchCalls, 1);
  });
});

// The Action Center's own real complaint (2026-08-24): componentTemplateVerification/
// contentWrapperAvailability are deliberately synchronous/in-memory-only (see
// design-drift.js's own "safe on the hot path" comment — they're also read
// from generateDraft's hot HTTP path), so they always returned the same
// static "queued, no action needed" text — even when a real Design Agent
// job had already failed hours earlier. These tests cover the async
// enrichment layer (implementers/lib/design-agent-status.js) this pass adds
// on top, via the module's own `designAgentStatus` injection point.
describe('createRecommendationGates — Design Agent status enrichment (honest blocked_reason, not a static reassurance)', () => {
  // A page whose url_file_map mapping already resolves, so ONLY the design
  // check can be the source of any blockedReason — isolates what's under test
  // from the (already covered elsewhere) page-mapping gate.
  const designSite = {
    id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main', auto_remediation_enabled: true,
    url_file_map: { pages: { '/page': { file: 'src/pages/page.njk' } } }, // no componentTemplates entry -> design check fails
  };
  // The page mapping above already resolves, so evaluate()'s file-existence
  // check (cachedFetchFile) is reached — without a stub it would hit the
  // real GitHub API for a fake repo, 404, and drop the recommendation as
  // 'file-missing' before ever reaching the design check this suite is
  // actually about.
  const designDeps = (extra = {}) => ({ ...neutralDeps(), fetchFile: async () => ({ content: 'ok' }), ...extra });

  test('enriches a blocked design-check with the real, persisted job status', async () => {
    let calls = 0;
    const designAgentStatus = async (site, { succeeded }) => {
      calls++;
      assert.equal(site.id, 1);
      assert.equal(succeeded, false);
      return { state: 'failed', jobId: 628, detail: 'Design Agent setup failed (job #628). See the latest attempt for details.' };
    };
    const gates = createRecommendationGates(1, designSite, designDeps({ designAgentStatus }));

    const result = await gates.evaluate('expand-content', { page: 'https://acme.com/page' });

    assert.equal(calls, 1);
    assert.equal(result.blockedReason, 'Design Agent setup failed (job #628). See the latest attempt for details.');
  });

  test('one status lookup per PASS, not per recommendation — shared across every generatorId', async () => {
    let calls = 0;
    const designAgentStatus = async () => { calls++; return { state: 'queued', detail: 'Design Agent setup is queued and will run shortly.' }; };
    const gates = createRecommendationGates(1, designSite, designDeps({ designAgentStatus }));

    await gates.evaluate('expand-content', { page: 'https://acme.com/page' });
    await gates.evaluate('qa-content', { page: 'https://acme.com/page' });
    await gates.evaluate('faq', { page: 'https://acme.com/page' });

    assert.equal(calls, 1, 'every actionType\'s template is projected from the SAME site-wide design-profile job — one lookup covers all of them');
  });

  test('never queried for a site that has not been through its auto-remediation review — nothing will ever run automatically for it', async () => {
    let calls = 0;
    const designAgentStatus = async () => { calls++; return { state: 'never_attempted', detail: 'x' }; };
    const unreviewedSite = { ...designSite, auto_remediation_enabled: false };
    const gates = createRecommendationGates(1, unreviewedSite, designDeps({ designAgentStatus }));

    const result = await gates.evaluate('expand-content', { page: 'https://acme.com/page' });

    assert.equal(calls, 0);
    assert.match(result.blockedReason, /component template/i, 'falls back to design-drift.js\'s own static message, unenriched');
  });

  test('never queried for a site with no repository connected', async () => {
    let calls = 0;
    const designAgentStatus = async () => { calls++; return { state: 'never_attempted', detail: 'x' }; };
    const noRepoSite = { ...designSite, repo_owner: null, repo_name: null };
    const gates = createRecommendationGates(1, noRepoSite, designDeps({ designAgentStatus }));

    await gates.evaluate('expand-content', { page: 'https://acme.com/page' });

    assert.equal(calls, 0);
  });

  test('not queried at all once the design check already passes — a verified template needs no status lookup', async () => {
    let calls = 0;
    const designAgentStatus = async () => { calls++; return { state: 'never_attempted', detail: 'x' }; };
    const verifiedSite = {
      ...designSite,
      url_file_map: {
        ...designSite.url_file_map,
        siteRoot: { componentTemplates: { expandContent: { wrapper: '<div>{{ROWS}}</div>', row: '<p>{{HEADING}}{{BODY}}</p>', verifiedAt: new Date().toISOString(), verifiedBy: 'design-agent' } } },
      },
    };
    const gates = createRecommendationGates(1, verifiedSite, designDeps({ designAgentStatus }));

    const result = await gates.evaluate('expand-content', { page: 'https://acme.com/page' });

    assert.equal(calls, 0);
    assert.equal(result.blockedReason, null);
  });

  test('a status-lookup failure degrades to the original static message rather than throwing the whole pass', async () => {
    const designAgentStatus = async () => { throw new Error('db unreachable'); };
    const gates = createRecommendationGates(1, designSite, designDeps({ designAgentStatus, log: { log: () => {}, warn: () => {} } }));

    const result = await gates.evaluate('expand-content', { page: 'https://acme.com/page' });

    assert.match(result.blockedReason, /component template/i);
  });

  test('the mapping gate still wins over the design gate when both would block — unchanged precedence', async () => {
    const designAgentStatus = async () => ({ state: 'failed', detail: 'Design Agent setup failed.' });
    const unmappedSite = { id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main', auto_remediation_enabled: true, url_file_map: {} };
    const gates = createRecommendationGates(1, unmappedSite, {
      ...neutralDeps(), designAgentStatus, healFn: async () => null, fetchTree: async () => ({ files: [], truncated: false }),
    });

    const result = await gates.evaluate('expand-content', { page: 'https://acme.com/page' });

    assert.doesNotMatch(result.blockedReason || '', /Design Agent/, 'the page-mapping reason must win — no point discussing a template for a page we cannot even locate a file for');
  });
});

describe('createRecommendationGates — faq/qa-content vs an already-schema\'d file', () => {
  // Mirrors the /resources/?type=report vs ?type=ebook vs ?type=webinar
  // shape: several distinct GSC URLs that all resolve (resolveFile matches on
  // pathname only) to the SAME file.
  const mappedSite = { id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main', url_file_map: { pages: { '/resources/': { file: 'src/pages/resources.njk' } } } };

  test('drops a qa-content candidate whose file already carries an FAQPage schema', async () => {
    const gates = createRecommendationGates(1, mappedSite, {
      ...neutralDeps(), fetchFile: async () => ({ content: '<script type="application/ld+json">{"@type":"FAQPage"}</script>' }),
    });

    const result = await gates.evaluate('qa-content', { page: 'https://acme.com/resources/?type=ebook' });

    assert.equal(result.drop, 'faq-schema-already-present');
  });

  test('drops a faq candidate the same way', async () => {
    const gates = createRecommendationGates(1, mappedSite, {
      ...neutralDeps(), fetchFile: async () => ({ content: '{"@type": "FAQPage"}' }),
    });

    const result = await gates.evaluate('faq', { page: 'https://acme.com/resources/?type=webinar' });

    assert.equal(result.drop, 'faq-schema-already-present');
  });

  test('does not drop when the file has no FAQPage schema yet', async () => {
    const gates = createRecommendationGates(1, mappedSite, {
      ...neutralDeps(), fetchFile: async () => ({ content: '<div>no schema here</div>' }),
    });

    const result = await gates.evaluate('qa-content', { page: 'https://acme.com/resources/?type=report' });

    assert.equal(result.drop, null);
  });

  test('does not drop a non-faq generator sharing the same schema\'d file', async () => {
    const gates = createRecommendationGates(1, mappedSite, {
      ...neutralDeps(), fetchFile: async () => ({ content: '<script type="application/ld+json">{"@type":"FAQPage"}</script>' }),
    });

    const result = await gates.evaluate('meta-title', { page: 'https://acme.com/resources/?type=ebook' });

    assert.equal(result.drop, null);
  });
});

// The stale-gate fix. This gate used to mirror a hard 422 in generateDraft;
// that 422 was removed (routes/action-center.js now warns and generates with
// whatever the render path can produce), but the demotion here stayed — so
// real, shippable faq/expand-content/internal-links/qa-content work kept
// being forced to the 'manual' tier on behalf of a block that no longer
// existed. These cover the replacement rule: block only when the render path
// would genuinely fall through to generic DEFAULT_* markup.
describe('createRecommendationGates — design context availability (not stored-template presence)', () => {
  // A real v2 profile: enough for design-profile.js's projectors to compose a
  // template for every marker-merge action type.
  const USABLE_PROFILE = {
    version: 2,
    typography: {
      heading: { section: 'text-3xl font-bold', item: 'text-xl font-semibold' },
      body: 'text-gray-600 leading-relaxed',
      link: 'text-blue-600 underline',
    },
    color: { primary: '#111827', background: '#ffffff', text: '#374151' },
    spacing: { section: 'py-12', stack: 'space-y-4' },
    layout: { container: 'max-w-4xl mx-auto px-4' },
    components: {
      accordion: { wrapper: 'divide-y', trigger: 'font-medium py-3', panel: 'pb-3 text-gray-600' },
      button: { primary: 'btn btn-primary' },
      card: { wrapper: 'rounded-lg border p-6', body: 'mt-2' },
    },
    responsive: { breakpoints: ['sm:', 'md:'] },
  };

  const siteWith = (siteRoot) => ({
    id: 1, repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main', auto_remediation_enabled: true,
    url_file_map: { pages: { '/page': { file: 'src/pages/page.njk' } }, ...(siteRoot ? { siteRoot } : {}) },
  });
  const deps = () => ({ ...neutralDeps(), fetchFile: async () => ({ content: 'ok' }), designAgentStatus: async () => null });

  for (const generatorId of ['faq', 'expand-content', 'internal-links', 'qa-content']) {
    test(`${generatorId} is NOT blocked when the site's design profile can project a template`, async () => {
      const gates = createRecommendationGates(1, siteWith({ designProfile: USABLE_PROFILE }), deps());

      const result = await gates.evaluate(generatorId, { page: 'https://acme.com/page' });

      assert.equal(result.drop, null);
      assert.equal(
        result.blockedReason, null,
        `${generatorId} renders through marker-merge's projection branch (the site's own typography and components), so there is nothing to block on`,
      );
    });
  }

  test('still blocked when there is no design knowledge at all — the fix would be generic DEFAULT_* markup', async () => {
    const gates = createRecommendationGates(1, siteWith(null), deps());

    const result = await gates.evaluate('faq', { page: 'https://acme.com/page' });

    assert.equal(result.drop, null, 'a real finding is never dropped — it stays visible');
    assert.ok(result.blockedReason, 'blocked, because nothing about this site is known yet');
  });

  test('still blocked when a stored profile exists but is too incomplete to project from', async () => {
    const unusable = { version: 2, typography: {}, layout: {} };
    const gates = createRecommendationGates(1, siteWith({ designProfile: unusable }), deps());

    const result = await gates.evaluate('expand-content', { page: 'https://acme.com/page' });

    assert.ok(result.blockedReason);
  });

  test('a verified stored template still passes on its own, with no profile present', async () => {
    const stored = {
      componentTemplates: {
        faq: {
          wrapper: '<dl class="divide-y">{{ROWS}}</dl>',
          row: '<dt>{{QUESTION}}</dt><dd>{{ANSWER}}</dd>',
          verifiedAt: new Date().toISOString(),
          verifiedBy: 'test',
        },
      },
    };
    const gates = createRecommendationGates(1, siteWith(stored), deps());

    const result = await gates.evaluate('faq', { page: 'https://acme.com/page' });

    assert.equal(result.blockedReason, null);
  });

  test("action types with no component-template concept are unaffected", async () => {
    const gates = createRecommendationGates(1, siteWith(null), deps());

    const result = await gates.evaluate('meta-title', { page: 'https://acme.com/page' });

    assert.equal(result.blockedReason, null);
  });
});
