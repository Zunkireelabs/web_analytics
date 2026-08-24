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
