import { test, describe, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// The page-type classification (generators/lib/content-type.js) at the two route-level points that matter:
//   generateDraft  — resolves it ONCE and stores it on the draft's input, with its evidence, and hands it to the generator and the gate
//   validateDraft  — the approval step: reads what was stored; for a draft made before classification existed it resolves it with the
//                    same function and SAVES it back, so nothing downstream works it out again
// Same approach as action-center.approve-publish.characterization.test.js: the real module, with only the collaborators that would reach
// the database, the model, GitHub or a browser replaced.
const R = (p) => new URL(p, import.meta.url).href;
// The real `openai` package cannot be linked under node:test's module mocking (openai -> formdata-node -> web-streams-polyfill has no ESM named
// export `ReadableStream` there), and the real generators/registry.js below reaches it through llm.js. No model is called here, so it is stubbed.
mock.module('openai', { defaultExport: class FakeOpenAI {} });
const real = async (p) => ({ ...(await import(R(p))) });
const calls = [];
let st;

const bannedSite = { id: 1, repo_owner: 'acme', repo_name: 'site', url_file_map: { siteRoot: { visibleClaimBans: ['consultancy'], visibleClaimBansExemptArticlePages: true }, newContentTargets: { 'blog-outline': { urlPattern: '/blogs/{slug}', dir: 'src/blog', extension: '.md' }, 'landing-page': { urlPattern: '/{slug}', dir: 'src/pages', extension: '.md' } }, renderCapabilities: { generator: 'eleventy', extensions: { '.md': { markdown: true, html: true } } } } };
const plainSite = { id: 1, repo_owner: 'acme', repo_name: 'site', url_file_map: { siteRoot: {} } };

function fresh() {
  return { site: bannedSite, draft: null, created: null, generatorParams: null, gateOpts: null, saved: [], jobStatuses: [], submitted: [] };
}

mock.module(R('../store/read.js'), { namedExports: { ...(await real('../store/read.js')), getSiteById: async () => st.site } });
mock.module(R('../store/drafts.js'), { namedExports: { ...(await real('../store/drafts.js')),
  getDraft: async () => st.draft,
  getDraftByFindingId: async () => null,
  createDraft: async (siteId, args) => { st.created = args; return { id: 99, status: 'draft', action_type: args.actionType, input: args.input, content: args.content }; },
  saveDraftPageClassification: async (siteId, id, c) => { st.saved.push({ id, status: c.status, pageType: c.pageType }); return { id }; },
  recordValidationStatus: async () => {},
  submitDraftForApproval: async (siteId, id) => { st.submitted.push(id); return { id, status: 'submitted_for_approval' }; },
} });
mock.module(R('../store/execution-jobs.js'), { namedExports: { ...(await real('../store/execution-jobs.js')),
  addJobRecommendation: async (jobId, recId) => ({ id: `jr-${recId}` }),
  updateJobRecommendationStatus: async (id, status, extra) => { st.jobStatuses.push({ id, status, ...extra }); },
  appendJobLog: async () => {},
  finishExecutionJob: async (id, v) => ({ id, ...v }),
} });
mock.module(R('../store/recommendations.js'), { namedExports: { ...(await real('../store/recommendations.js')),
  setRecommendationExecutionState: async () => {},
} });
mock.module(R('../generators/lib/quality-gate.js'), { namedExports: { ...(await real('../generators/lib/quality-gate.js')),
  runQualityGate: async (content, generatorId, siteId, opts) => { st.gateOpts = opts; return st.gateClean ? { clean: true, issues: [] } : { clean: false, issues: [{ patternId: 'stop-here' }] }; } } });
mock.module(R('../generators/registry.js'), { namedExports: { ...(await real('../generators/registry.js')),
  getGenerator: async (id) => ({ meta: { id }, generate: async ({ params }) => { st.generatorParams = params; return { content: { sections: [] }, summary: 'ok' }; } }) } });

// runSafeFixesJob calls generateDraft with waitForDesignAgent: true, which asks resolveOrCreateComponentTemplate to start a Design Agent run for the
// missing component template and WAIT for it (up to a long budget) — for these fixture sites that never finishes, so the whole file stalled. Page
// classification does not depend on the template, so it reports "not available" at once, exactly what a site with no design context answers.
mock.module(R('../implementers/lib/design-drift.js'), { namedExports: { ...(await real('../implementers/lib/design-drift.js')),
  resolveOrCreateComponentTemplate: async () => ({ ok: false, reason: 'missing' }),
} });
const { validateDraft, generateDraft, runSafeFixesJob } = await import(R('./action-center.js'));

// The real db.js is in the import graph and opens a connection pool; without closing it the process never exits and the file reports a timeout.
after(async () => { const { pool } = await import(R('../db.js')); await pool.end().catch(() => {}); });

beforeEach(() => { calls.length = 0; st = fresh(); });

const submitted = (over = {}) => ({ id: 7, status: 'submitted_for_approval', action_type: 'faq', content: { page: 'https://x.test/blogs/post' }, input: { page: 'https://x.test/blogs/post' }, ...over });
const stopsAtGate = (fn) => assert.rejects(fn, (e) => e.status === 422);

describe('validateDraft — a draft made before classification existed', () => {
  test('it is classified by the shared function, SAVED back, and the gate receives it', async () => {
    st.draft = submitted();
    await stopsAtGate(() => validateDraft(1, 7));
    assert.deepEqual(st.saved, [{ id: 7, status: 'resolved', pageType: 'blog-post' }]);
    assert.equal(st.gateOpts.pageClassification.status, 'resolved');
    assert.equal(st.gateOpts.pageType, 'blog-post');
  });
  test('a draft that already carries a classification is reused: nothing is resolved or saved again', async () => {
    const stored = { status: 'resolved', pageType: 'landing-page', group: 'non-article', confidence: 'high', evidence: [{ source: 'declared', pageType: 'landing-page', strength: 'high' }], tentativeType: null, resolvedAt: '2026-11-22T00:00:00.000Z' };
    st.draft = submitted({ input: { page: 'https://x.test/blogs/post', pageType: 'landing-page', pageClassification: stored } });
    await stopsAtGate(() => validateDraft(1, 7));
    assert.deepEqual(st.saved, []);
    assert.equal(st.gateOpts.pageClassification, stored, 'the stored result stands even though the URL looks like a blog');
  });
  test('an unclear type is saved as unknown, with no pageType trusted', async () => {
    st.draft = submitted({ content: {}, input: {} });
    await stopsAtGate(() => validateDraft(1, 7));
    assert.equal(st.saved.length, 1); assert.equal(st.saved[0].status, 'unknown'); assert.equal(st.saved[0].pageType, null);
    assert.equal(st.gateOpts.pageType, null);
  });
  test('a site with no type-dependent restriction is not classified at approval (nothing depends on it, so no page read)', async () => {
    st.site = plainSite; st.draft = submitted();
    await stopsAtGate(() => validateDraft(1, 7));
    assert.deepEqual(st.saved, []);
    assert.equal(st.gateOpts.pageClassification, null);
  });
});

describe('generateDraft — classifies once and stores the result with its evidence', () => {
  beforeEach(() => { st.gateClean = true; });

  test('a blog draft with NO URL: stored as blog, the generator and the gate receive the same stored result', async () => {
    const draft = await generateDraft(1, { generatorId: 'blog-outline', params: { topic: 'UK visa rules' }, source: 'test', waitForDesignAgent: false });
    assert.equal(draft.input.pageType, 'blog');
    assert.equal(draft.input.pageClassification.status, 'resolved');
    assert.ok(draft.input.pageClassification.evidence.length >= 1, 'the evidence is stored');
    assert.equal(st.created.input.pageClassification, draft.input.pageClassification);
    assert.equal(st.generatorParams.pageType, 'blog', 'the generator got the resolved type');
    assert.equal(st.generatorParams.pageClassification.status, 'resolved');
    assert.equal(st.gateOpts.pageClassification.pageType, 'blog', 'the Quality Gate got the same stored result');
    assert.equal(st.generatorParams.topic, 'UK visa rules', "the caller's own params are untouched");
  });
  test('a landing-page draft with no URL is stored as a landing page — a missing URL does not make it a blog', async () => {
    const draft = await generateDraft(1, { generatorId: 'landing-page', params: { topic: 'Study in Canada' }, source: 'test' });
    assert.equal(draft.input.pageType, 'landing-page');
    assert.equal(st.gateOpts.pageClassification.group, 'non-article');
  });
  test('an unidentified type is stored as unknown with NO pageType, and the gate is told so', async () => {
    const draft = await generateDraft(1, { generatorId: 'faq', params: {}, source: 'test' });
    assert.equal(draft.input.pageClassification.status, 'unknown');
    assert.equal('pageType' in draft.input, false);
    assert.equal(st.gateOpts.pageClassification.status, 'unknown');
  });
  test('an existing blog post edited by another generator is recognised from its URL', async () => {
    const draft = await generateDraft(1, { generatorId: 'faq', params: { page: 'https://x.test/blogs/existing' }, source: 'test' });
    assert.equal(draft.input.pageType, 'blog-post');
    assert.equal(st.gateOpts.pageType, 'blog-post');
  });
});

describe('execution-engine route (runSafeFixesJob) — an unidentified page type is left for a person', () => {
  beforeEach(() => { st.gateClean = true; });
  const job = { id: 5, requested_by: 9 };
  const recFor = (type, page = null) => ({ id: 11, recommendation_type: type, page, params: page ? { page, query: 'q' } : {}, finding_ids: ['f-11'], detecting_agents: ['opportunity'] });
  const runJob = (rec) => runSafeFixesJob({ job, recs: [rec], pendingDraftFilePaths: new Set(), site: st.site, branchName: 'batch-test' });

  test('an unclear type on a site with a type-dependent ban: the draft is NOT submitted, and the job says why', async () => {
    const result = await runJob(recFor('faq'));
    assert.deepEqual(st.submitted, [], 'never submitted, approved or pushed');
    assert.equal(result.shipped, 0);
    assert.equal(result.failed, 1);
    const failure = st.jobStatuses.find((s) => s.status === 'failed');
    assert.match(failure.error, /left for review: its page type could not be identified/);
  });
  test('a resolved type is submitted as normal', async () => {
    await runJob(recFor('blog-outline')).catch(() => {}); // later steps need GitHub; only the submit decision matters here
    assert.deepEqual(st.submitted, [99]);
  });
});
