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
