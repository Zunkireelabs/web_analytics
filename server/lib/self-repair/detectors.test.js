import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectCapabilityFindings, blogTargetFromOwnPatterns, missingKeysFromRefusal, headingEvidenceFromProfile } from './detectors.js';

const NOW = new Date('2026-11-26T06:00:00Z');
const ago = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();
const base = (over = {}) => ({
  site: { id: 1, name: 'Client', repo_owner: 'o', repo_name: 'r', growth_started_at: ago(20), url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md' } }, siteRoot: { pageTemplates: { 'blog-article': {} }, designProfile: { pageTypePatterns: { 'blog-article': {} } } } } },
  openBlogRecs: 10, blogDrafts14d: 0, renderMismatchAbandoned: 0, blogRefusals: [], pendingPatterns: [], skippedBlogItems: [], siblingConstants: {}, siblingsSampled: 0,
  keyword: { gaps: 12, lastRunAt: ago(3), skipReason: null, blockedPaths: [], paths: [] }, ...over,
});
const kinds = (f) => f.map((x) => x.kind);

describe('self-repair detectors: a healthy project has no findings', () => {
  test('nothing missing -> nothing reported', () => assert.deepEqual(detectCapabilityFindings(base(), { now: NOW }), []));
});

describe('blog target', () => {
  test('missing target is derived ONLY from the project\'s own url patterns', () => {
    const f = base({ site: { ...base().site, url_file_map: { patterns: [{ file: 'src/blog/$1.md', match: '^/blog/([^/]+)/?$' }] } } });
    const out = detectCapabilityFindings(f, { now: NOW });
    assert.deepEqual(kinds(out), ['missing-blog-target']);
    assert.deepEqual(out[0].proposal.patch.value, { dir: 'src/blog', extension: '.md' });
    assert.equal(out[0].blocker, null);
  });
  test('no evidence in the project\'s own map -> a blocker, never a guess', () => {
    const out = detectCapabilityFindings(base({ site: { ...base().site, url_file_map: {} } }), { now: NOW });
    assert.equal(out[0].proposal, null); assert.match(out[0].blocker, /person/);
  });
  test('derivation reads the pattern\'s own folder and file type', () => {
    assert.deepEqual(blogTargetFromOwnPatterns({ patterns: [{ file: 'src/blog/$1/index.njk', match: '^/blog/([^/]+)/?$' }] }).target, { dir: 'src/blog', extension: '.njk' });
    assert.equal(blogTargetFromOwnPatterns({ patterns: [{ file: 'src/pages/$1.md', match: '^/([^/]+)/$' }] }), null);
  });
});

describe('front-matter defaults', () => {
  const refusal = 'unspecified-refusal: This recommendation could not be prepared yet — Every existing post in this directory declares "author", "category", and the site\'s build rejects a post without them.';
  test('keys are read from the refusal text', () => assert.deepEqual(missingKeysFromRefusal(refusal), ['author', 'category']));
  test('covered by the project\'s own posts -> the repair is the deploy, no config change', () => {
    const out = detectCapabilityFindings(base({ blogRefusals: [refusal], siblingConstants: { author: 'Team', category: 'SEO' }, siblingsSampled: 9 }), { now: NOW });
    const f = out.find((x) => x.kind === 'front-matter-defaults-missing');
    assert.equal(f.proposal.action, 'deploy-sibling-derivation'); assert.equal(f.blocker, null);
  });
  test('not covered -> a blocker naming the keys; the platform never invents an author', () => {
    const out = detectCapabilityFindings(base({ blogRefusals: [refusal], siblingConstants: { author: 'Team' } }), { now: NOW });
    const f = out.find((x) => x.kind === 'front-matter-defaults-missing');
    assert.equal(f.proposal, null); assert.match(f.blocker, /"category"/);
  });
  test('already set in the project\'s own map -> nothing to report', () => {
    const site = base().site; site.url_file_map.newContentTargets['blog-outline'].frontMatterDefaults = { author: 'Team', category: 'SEO' };
    assert.equal(detectCapabilityFindings(base({ site, blogRefusals: [refusal] }), { now: NOW }).filter((x) => x.kind === 'front-matter-defaults-missing').length, 0);
  });
});

describe('blog waiting on a design decision (the Admizz case)', () => {
  const stalled = base({ pendingPatterns: [{ id: 'p1', pageType: 'blog-article', generatorId: 'blog-outline', createdAt: ago(20) }],
    skippedBlogItems: [{ day: '2026-11-24', skipReason: 'needs-design-decision', reason: 'x' }, { day: '2026-11-25', skipReason: 'needs-design-decision', reason: 'y' }] });
  test('names the wait, its age, and the repair', () => {
    const out = detectCapabilityFindings(stalled, { now: NOW });
    const w = out.find((x) => x.kind === 'blog-waiting-on-design-decision');
    assert.equal(w.severity, 'high'); assert.equal(w.evidence.pendingDays, 20); assert.equal(w.proposal.action, 'rederive-design-profile');
    assert.ok(kinds(out).includes('blog-selection-stalled'));
  });
  test('a fresh proposal is only a warning', () => {
    const out = detectCapabilityFindings(base({ pendingPatterns: [{ id: 'p', pageType: 'blog-article', generatorId: 'blog-outline', createdAt: ago(0) }] }), { now: NOW });
    assert.equal(out.find((x) => x.kind === 'blog-waiting-on-design-decision').severity, 'warning');
  });
  test('a stalled selection with no explanation says so instead of guessing', () => {
    const out = detectCapabilityFindings(base({ skippedBlogItems: [{ day: 'a', skipReason: 'not-reached', reason: 'r' }, { day: 'b', skipReason: 'not-reached', reason: 'r' }] }), { now: NOW });
    const s = out.find((x) => x.kind === 'blog-selection-stalled'); assert.equal(s.proposal, null); assert.ok(s.blocker);
  });
});

describe('no blog template (the Zennly case)', () => {
  test('a docs folder is not a blog: reported with a blocker that needs a design proposal', () => {
    const site = { id: 2, name: 'Z', repo_owner: 'o', repo_name: 'r', growth_started_at: ago(20), url_file_map: { newContentTargets: { 'blog-outline': { dir: 'docs/marketing', extension: '.md' } }, siteRoot: { designProfile: {} } } };
    const out = detectCapabilityFindings(base({ site }), { now: NOW });
    const f = out.find((x) => x.kind === 'no-blog-template');
    assert.ok(f); assert.match(f.blocker, /documentation folder/); assert.equal(f.proposal, null);
  });
});

describe('evidence beats stored config', () => {
  test('articles abandoned for "no article page to compare against" are reported even when a stored template exists', () => {
    const out = detectCapabilityFindings(base({ noArticlePageAbandoned: 4 }), { now: NOW });
    const f = out.find((x) => x.kind === 'no-blog-template');
    assert.ok(f); assert.equal(f.evidence.abandonedForNoArticlePage, 4);
  });
  test('generator-written keys (title, date, excerpt) are not "missing defaults": covered author/category -> a deploy repair, no blocker', () => {
    const f = base({ blogRefusals: ['unspecified-refusal: Every existing post in this directory declares "auth'], requiredKeys: ['author', 'category', 'cover', 'date', 'excerpt', 'title'], siblingConstants: { author: 'A', category: 'C', cover: { kind: 'agent' } }, siblingsSampled: 8 });
    const x = detectCapabilityFindings(f, { now: NOW }).find((y) => y.kind === 'front-matter-defaults-missing');
    assert.equal(x.proposal.action, 'deploy-sibling-derivation'); assert.equal(x.blocker, null);
    assert.deepEqual(x.evidence.keys, ['author', 'category', 'cover']);
  });
  test('truncated refusal text and no readable siblings -> says the keys are unknown, never guesses', () => {
    const x = detectCapabilityFindings(base({ blogRefusals: ['Every existing post in this directory declares "auth'] }), { now: NOW }).find((y) => y.kind === 'front-matter-defaults-missing');
    assert.equal(x.subject, 'unknown-keys'); assert.equal(x.proposal, null);
  });
});

describe('render mismatch and keyword discovery', () => {
  test('abandoned articles are reported and the gate is not relaxed', () => {
    const f = detectCapabilityFindings(base({ renderMismatchAbandoned: 10 }), { now: NOW }).find((x) => x.kind === 'blog-render-mismatch');
    assert.equal(f.proposal.action, 'rerender-abandoned-drafts'); assert.match(f.proposal.steps.join(' '), /never relaxed/); assert.equal(f.blocker, null);
  });
  test('a blocked discovery path is stated per path with its recorded reason, and nothing is invented', () => {
    const k = { gaps: 5, lastRunAt: null, skipReason: 'dataforseo_demand: no credit', paths: [{ path: 'dataforseo_demand', status: 'blocked' }, { path: 'own_search_queries', status: 'ok' }],
      blockedPaths: [{ path: 'dataforseo_demand', status: 'blocked', reasonCode: 'dataforseo_payment_required', message: 'DataForSEO has no credit.' }] };
    const f = detectCapabilityFindings(base({ keyword: k }), { now: NOW }).find((x) => x.kind === 'keyword-discovery-blocked');
    assert.match(f.blocker, /no search data is invented/); assert.match(f.blocker, /other discovery path is working/);
  });
  test('a project with no keyword at all and no recorded reason gets a blocker, not silence', () => {
    const f = detectCapabilityFindings(base({ keyword: { gaps: 0, lastRunAt: null, skipReason: null, blockedPaths: [], paths: [] } }), { now: NOW }).find((x) => x.kind === 'keyword-discovery-missing');
    assert.ok(f.blocker);
  });
  test('a project younger than a week is not flagged', () => {
    const f = base({ keyword: { gaps: 0, blockedPaths: [], paths: [] } }); f.site.growth_started_at = ago(2);
    assert.equal(detectCapabilityFindings(f, { now: NOW }).filter((x) => x.kind === 'keyword-discovery-missing').length, 0);
  });
});

describe('every finding is actionable', () => {
  test('each finding carries a proposal or a blocker, never neither', () => {
    const wild = base({ renderMismatchAbandoned: 1, blogRefusals: ['declares "author", x'], pendingPatterns: [{ id: 'p', pageType: 'blog-article', createdAt: ago(9) }], skippedBlogItems: [{ day: 'a', skipReason: 's' }, { day: 'b', skipReason: 's' }], keyword: { gaps: 0, blockedPaths: [{ path: 'p', status: 'blocked', message: 'm' }], paths: [] } });
    for (const f of detectCapabilityFindings(wild, { now: NOW })) assert.ok(f.proposal || f.blocker, f.kind);
  });
});


describe('heading-evidence-not-in-body (the Zennly shape)', () => {
  const he = (o) => ({ recordedClass: null, observedInBody: undefined, bare: false, bodyHeadingCount: 0, bodyHeadingClasses: [], ...o });
  const run = (headingEvidence) => detectCapabilityFindings(base({ headingEvidence }), { now: NOW }).filter((f) => f.kind === 'heading-evidence-not-in-body');
  test('a recorded class that reads like navigation, with bare body headings, is flagged with the re-derive repair', () => {
    const f = run(he({ recordedClass: 'v2-mm__aside-title', bodyHeadingCount: 6 }));
    assert.equal(f.length, 1); assert.equal(f[0].severity, 'high'); assert.equal(f[0].proposal.action, 'rederive-design-profile'); assert.equal(f[0].blocker, null);
    assert.equal(f[0].evidence.chromeLike, true); assert.match(f[0].summary, /v2-mm__aside-title/);
  });
  test('a recorded class that no captured body heading uses is flagged even when its name looks innocent', () => {
    assert.equal(run(he({ recordedClass: 'post-title', bodyHeadingCount: 4, bodyHeadingClasses: ['other-h2'] })).length, 1);
  });
  test('a class the body headings DO use is fine, and so is evidence marked observed in the body', () => {
    assert.equal(run(he({ recordedClass: 'post-h2', bodyHeadingCount: 4, bodyHeadingClasses: ['post-h2 x', 'post-h2'] })).length, 0);
    assert.equal(run(he({ recordedClass: 'post-h2', observedInBody: true, bodyHeadingCount: 4, bodyHeadingClasses: [] })).length, 0);
  });
  test('a bare record, or no record at all, or an innocent class with no body evidence to contradict it: nothing to say', () => {
    assert.equal(run(he({ bare: true })).length, 0); assert.equal(run(undefined).length, 0);
    assert.equal(run(he({ recordedClass: 'h2' })).length, 0, 'unverifiable and not chrome-like: not accused');
  });
  test('the facts are read from the stored design profile only (this client\'s), body headings included', () => {
    const profile = { pageTypePatterns: { 'blog-article': { textHierarchy: [{ role: 'subheading', classes: 'v2-mm__aside-title' }] } },
      pages: [{ pageType: 'blog-article', bodyHeadings: [{ level: 2, classes: '' }, { level: 3, classes: 'x' }] }, { pageType: 'service', bodyHeadings: [{ level: 2, classes: 'not-this' }] }] };
    assert.deepEqual(headingEvidenceFromProfile(profile), { recordedClass: 'v2-mm__aside-title', observedInBody: undefined, bare: false, bodyHeadingCount: 2, bodyHeadingClasses: ['x'] });
    assert.deepEqual(headingEvidenceFromProfile(null), { recordedClass: null, observedInBody: undefined, bare: false, bodyHeadingCount: 0, bodyHeadingClasses: [] });
  });
});
