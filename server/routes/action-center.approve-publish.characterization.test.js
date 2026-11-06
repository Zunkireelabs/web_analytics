import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// CHARACTERIZATION TESTS for approveAndPublishDraft(): they record what the function does TODAY, before validation is extracted
// from publishing. They are deliberately about observable behaviour (what is called, in what order, what is thrown, what is
// returned), so the extraction must keep every one of them green without changing a single assertion.
//
// The property everything else rests on: NOTHING is approved or pushed until every check has passed. Order today:
//   Quality Gate -> (repo) resolve implementer -> preview + responsive repair loop (max 3 checks) -> persist repaired content
//   -> rendering gate -> technical check + repair loop (max 2 repairs) -> persist -> approveDraft -> apply (push)
//   -> markDraftBranchPushed -> (deferPr ? stop) -> mergeToStage (PR) -> markDraftPrOpened | markDraftAwaitingPublish
//
// Mocking: each dependency module is the REAL module with only the functions under test replaced, so anything not overridden is
// the real code (and anything that would reach the database or GitHub is overridden).

const R = (p) => new URL(p, import.meta.url).href;
const calls = [];
const rec = (name, extra) => calls.push(extra === undefined ? name : `${name}:${extra}`);
let st;

function fresh() {
  return {
    draft: { id: 7, status: 'submitted_for_approval', action_type: 'meta-title', content: { title: 'Original' }, original_content: { title: 'Original' }, input: { page: 'https://x.example/a' }, finding_id: 'f-1' },
    site: { id: 1, repo_owner: 'acme', repo_name: 'site' },
    gate: () => ({ clean: true, issues: [] }),
    resolved: null,
    generator: null,
    rendering: { ok: true },
    preview: () => ({ ok: true, filePath: 'src/a.html', newContent: '<title>Original</title>', contentFormat: 'html' }),
    tech: () => ({ checkable: false }),
    apply: () => ({ ok: true, branchName: 'superrank/fix-7', renderMode: 'html', appliedFiles: ['src/a.html'] }),
    merge: () => ({ ok: true, prNumber: 42, prUrl: 'https://github.com/acme/site/pull/42' }),
    recommendation: null,
  };
}

const implementer = () => ({
  preview: async (_site, draft) => { rec('preview', JSON.stringify(draft.content)); return st.preview(draft); },
  apply: async (_site, draft) => { rec('apply', JSON.stringify(draft.content)); return st.apply(draft); },
  mergeToStage: async () => { rec('mergeToStage'); return st.merge(); },
});

const real = async (p) => ({ ...(await import(R(p))) });
mock.module(R('../store/drafts.js'), { namedExports: { ...(await real('../store/drafts.js')),
  getDraft: async () => { rec('getDraft'); return st.draft; },
  approveDraft: async (_s, id) => { rec('approveDraft'); return st.draft ? { ...st.draft, id, status: 'approved' } : null; },
  updateDraft: async (_s, _id, { content }) => { rec('updateDraft', JSON.stringify(content)); st.draft = { ...st.draft, content }; return st.draft; },
  recordValidationStatus: async (_s, _id, v) => { rec('recordValidationStatus', Object.keys(v).join(',')); },
  markDraftBranchPushed: async (_s, id, info) => { rec('markDraftBranchPushed', info.branchName); return { ...st.draft, id, status: 'branch_pushed' }; },
  markDraftPrOpened: async (_s, id, info) => { rec('markDraftPrOpened', info.prNumber); return { ...st.draft, id, status: 'pr_opened', pr_number: info.prNumber }; },
  markDraftAwaitingPublish: async (_s, id) => { rec('markDraftAwaitingPublish'); return { ...st.draft, id, status: 'awaiting_publish' }; },
  recordApplyFailure: async (_s, _id, error) => { rec('recordApplyFailure', error); },
  recordMergeFailure: async (_s, _id, error) => { rec('recordMergeFailure', error); },
} });
mock.module(R('../store/read.js'), { namedExports: { ...(await real('../store/read.js')), getSiteById: async () => st.site } });
mock.module(R('../generators/lib/quality-gate.js'), { namedExports: { ...(await real('../generators/lib/quality-gate.js')),
  runQualityGate: async (content) => { rec('qualityGate', JSON.stringify(content)); return st.gate(content); } } });
mock.module(R('../implementers/resolve.js'), { namedExports: { ...(await real('../implementers/resolve.js')),
  resolveImplementerForApply: async () => { rec('resolveImplementer'); return st.resolved; } } });
mock.module(R('../generators/registry.js'), { namedExports: { ...(await real('../generators/registry.js')), getGenerator: async () => st.generator } });
mock.module(R('../implementers/lib/rendering-gate.js'), { namedExports: { ...(await real('../implementers/lib/rendering-gate.js')),
  validateRendering: async () => { rec('renderingGate'); return st.rendering; } } });
mock.module(R('../store/fix-verifications.js'), { namedExports: { ...(await real('../store/fix-verifications.js')),
  verificationMethodFor: () => ({ method: 'PAGE_CONTENT', expected: 'title', target: null }) } });
mock.module(R('../agents/lib/fix-verification.js'), { namedExports: { ...(await real('../agents/lib/fix-verification.js')),
  checkContentAgainstExpectation: (_m, _e, newContent) => { rec('techCheck'); return st.tech(newContent); } } });
mock.module(R('../store/recommendations.js'), { namedExports: { ...(await real('../store/recommendations.js')),
  getRecommendationByFindingId: async () => st.recommendation,
  blockRecommendation: async (id) => { rec('blockRecommendation', id); } } });
mock.module(R('../agent-memory.js'), { namedExports: { ...(await real('../agent-memory.js')),
  recordFixOutcome: async (o) => { rec('recordFixOutcome', o.sourceType || o.outcome); return { id: 1 }; },
  getActiveAutoMemories: async () => { rec('getActiveAutoMemories'); return [{ id: 3 }]; } } });
mock.module(R('../agents/lib/draft-lesson-extraction.js'), { namedExports: { ...(await real('../agents/lib/draft-lesson-extraction.js')),
  extractEditLesson: () => ({ validationRuleId: 'title-length', title: 'Keep titles short', lesson: 'shorter titles' }) } });
mock.module(R('../store/design-choices.js'), { namedExports: { ...(await real('../store/design-choices.js')),
  createDesignChoice: async () => { rec('createDesignChoice'); } } });

const { approveAndPublishDraft } = await import(R('./action-center.js'));
const run = (opts = {}) => approveAndPublishDraft(1, 7, { userId: 9, ...opts });
const names = () => calls.map((c) => c.split(':')[0]);
const status422 = (e) => e.status === 422;

beforeEach(() => { calls.length = 0; st = fresh(); st.resolved = { implementer: implementer(), implementerId: 'backend' }; });

describe('approveAndPublishDraft: what happens before anything is published', () => {
  test('a missing draft, or one not submitted for approval, is a 404 and nothing else happens', async () => {
    st.draft = null;
    await assert.rejects(() => run(), (e) => e.status === 404);
    st = fresh(); st.draft.status = 'approved';
    await assert.rejects(() => run(), (e) => e.status === 404);
    assert.ok(!names().includes('qualityGate') && !names().includes('approveDraft'));
  });

  test('the Quality Gate runs on the CURRENT content and its result is recorded whether it passes or fails', async () => {
    st.gate = () => ({ clean: false, issues: [{ patternId: 'placeholder' }] });
    await assert.rejects(() => run(), (e) => status422(e) && /quality issue/.test(e.message) && e.issues?.length === 1);
    assert.deepEqual(names(), ['getDraft', 'qualityGate', 'recordValidationStatus']);
    assert.equal(calls[2], 'recordValidationStatus:qualityGate');
  });

  test('a site with no repository is approved without any implementer, preview or push', async () => {
    st.site = { id: 1 };
    const out = await run();
    assert.equal(out.status, 'approved');
    assert.deepEqual(names(), ['getDraft', 'qualityGate', 'recordValidationStatus', 'approveDraft']);
  });

  test('an uncertain render mode from resolution is a 422 before any preview; a resolution error is a 400', async () => {
    st.resolved = { reason: 'render-mode-uncertain', error: 'not sure how this page renders', confidence: 0.4, suggestedMode: 'html' };
    await assert.rejects(() => run(), (e) => status422(e) && e.reason === 'render-mode-uncertain');
    assert.ok(!names().includes('preview'));
    st = fresh(); st.resolved = { error: 'no implementer for this page' };
    await assert.rejects(() => run(), (e) => e.status === 400);
  });

  test('a preview failure that is not a layout regression fails at once: no repair, no approval, no push', async () => {
    st.preview = () => ({ ok: false, reason: 'missing-classes', error: 'uses classes the site does not have', missingClasses: ['x'] });
    await assert.rejects(() => run(), (e) => status422(e) && e.reason === 'missing-classes');
    assert.equal(names().filter((n) => n === 'preview').length, 1);
    assert.ok(!names().includes('approveDraft') && !names().includes('apply'));
  });

  test('a layout regression is repaired (regenerate, Quality Gate, re-preview), and the REPAIRED content is what gets approved and pushed', async () => {
    let n = 0;
    st.preview = () => (++n === 1 ? { ok: false, reason: 'responsive-regression', regressions: [{ kind: 'horizontal-overflow', width: 375, viewport: 'mobile', overflowPx: 40 }] } : fresh().preview());
    st.generator = { generate: async ({ params }) => { rec('regenerate', params.designCorrections ? 'with-correction' : 'plain'); return { content: { title: 'Repaired' } }; } };
    const out = await run();
    assert.equal(out.status, 'pr_opened');
    assert.ok(calls.includes('regenerate:with-correction'));
    assert.ok(calls.includes('updateDraft:{"title":"Repaired"}'), 'the repaired content is persisted before approval');
    assert.ok(calls.includes('apply:{"title":"Repaired"}'), 'and it is what is pushed');
    assert.ok(names().indexOf('updateDraft') < names().indexOf('approveDraft'));
  });

  test('a regression that survives every repair (3 checks) is refused, and the recommendation is handed to a person', async () => {
    st.preview = () => ({ ok: false, reason: 'responsive-regression', error: 'breaks the layout', regressions: [{ kind: 'horizontal-overflow', width: 375, viewport: 'mobile', overflowPx: 40 }] });
    st.generator = { generate: async () => ({ content: { title: 'Try again' } }) };
    st.recommendation = { id: 55 };
    await assert.rejects(() => run(), (e) => status422(e) && e.reason === 'responsive-regression');
    assert.equal(names().filter((n) => n === 'preview').length, 3, 'one real check plus two repairs');
    assert.ok(calls.includes('blockRecommendation:55'));
    assert.ok(!names().includes('approveDraft') && !names().includes('apply'));
  });

  test('a repair that fails the Quality Gate is abandoned at once (never previewed, never used)', async () => {
    st.preview = () => ({ ok: false, reason: 'responsive-regression', error: 'breaks the layout', regressions: [{ kind: 'horizontal-overflow', width: 375, viewport: 'mobile', overflowPx: 40 }] });
    st.generator = { generate: async () => ({ content: { title: 'BAD' } }) };
    st.gate = (content) => (content.title === 'BAD' ? { clean: false, issues: [{ patternId: 'x' }] } : { clean: true, issues: [] });
    await assert.rejects(() => run(), status422);
    assert.equal(names().filter((n) => n === 'preview').length, 1);
    assert.ok(!names().includes('approveDraft'));
  });

  test('a rendering-gate failure is recorded and refused before approval', async () => {
    st.rendering = { ok: false, error: 'this target cannot render Markdown', reason: 'markdown-unsafe' };
    await assert.rejects(() => run(), (e) => status422(e) && /can't be approved yet/.test(e.message));
    assert.ok(calls.includes('recordValidationStatus:renderingConfig'));
    assert.ok(!names().includes('approveDraft') && !names().includes('apply'));
  });

  test('content that does not do what it claims is repaired (at most 2 repairs); if it never does, it is refused before approval', async () => {
    st.tech = () => ({ checkable: true, present: false, evidence: { missing: 'title' } });
    st.generator = { generate: async () => { rec('regenerate'); return { content: { title: 'Still wrong' } }; } };
    await assert.rejects(() => run(), (e) => status422(e) && e.reason === 'seo-tech-validation-failed');
    assert.equal(names().filter((n) => n === 'regenerate').length, 2);
    assert.ok(!names().includes('approveDraft'));
  });

  test('a technical repair that works is persisted and then approved and pushed', async () => {
    let n = 0;
    st.tech = () => (++n === 1 ? { checkable: true, present: false, evidence: {} } : { checkable: true, present: true });
    st.generator = { generate: async () => ({ content: { title: 'Fixed claim' } }) };
    const out = await run();
    assert.equal(out.status, 'pr_opened');
    assert.ok(calls.includes('updateDraft:{"title":"Fixed claim"}'));
    assert.ok(calls.includes('apply:{"title":"Fixed claim"}'));
  });
});

describe('approveAndPublishDraft: the learning side effects of an approval', () => {
  test('a human-edited draft records its lesson (and flags an overridden auto memory) right after the Quality Gate, before any preview', async () => {
    st.draft.content = { title: 'Edited by a person' };
    await run();
    const order = names();
    assert.ok(calls.includes('recordFixOutcome:human-edit'), 'the edit lesson is recorded');
    assert.ok(order.includes('getActiveAutoMemories'), 'active auto memories are checked');
    assert.ok(calls.includes('recordFixOutcome:failure'), 'an auto memory a person overrode is recorded as a failed reuse');
    assert.ok(order.indexOf('recordFixOutcome') > order.indexOf('qualityGate') && order.indexOf('recordFixOutcome') < order.indexOf('preview'));
  });

  test('a draft whose generation self-corrected confirms that lesson on approval', async () => {
    st.draft.gate_resolved_patterns = ['placeholder'];
    await run();
    assert.ok(calls.includes('recordFixOutcome:runtime-auto'));
  });

  test('a Quality Gate failure records NO lesson', async () => {
    st.draft.content = { title: 'Edited by a person' };
    st.gate = () => ({ clean: false, issues: [{ patternId: 'x' }] });
    await assert.rejects(() => run(), status422);
    assert.ok(!names().includes('recordFixOutcome'));
  });
});

describe('approveAndPublishDraft: what happens once every check has passed', () => {
  test('the full happy path, in order: every check BEFORE approval, approval BEFORE the push, then the PR', async () => {
    const out = await run();
    assert.deepEqual(names(), ['getDraft', 'qualityGate', 'recordValidationStatus', 'resolveImplementer', 'preview', 'renderingGate', 'recordValidationStatus', 'techCheck',
      'approveDraft', 'apply', 'markDraftBranchPushed', 'mergeToStage', 'markDraftPrOpened']);
    assert.equal(out.status, 'pr_opened');
    assert.equal(out.pr_number, 42);
  });

  test('deferPr (a batch run): the branch is pushed but NO pull request is opened by this call', async () => {
    const out = await run({ deferPr: true });
    assert.equal(out.status, 'branch_pushed');
    assert.ok(!names().includes('mergeToStage'));
  });

  test('a push that fails is recorded and the current draft returned (no throw), and nothing is marked pushed', async () => {
    st.apply = () => ({ ok: false, error: 'GitHub said no' });
    await run();
    assert.ok(calls.includes('recordApplyFailure:GitHub said no'));
    assert.ok(!names().includes('markDraftBranchPushed'));
  });

  test('a push refused for an uncertain render mode is a 422 that reports the draft\'s real status', async () => {
    st.apply = () => ({ ok: false, reason: 'render-mode-uncertain', error: 'unsure', confidence: 0.3, suggestedMode: 'jsx' });
    await assert.rejects(() => run(), (e) => status422(e) && e.draftStatus === 'approved');
  });

  test('a PR that cannot be opened is recorded and the current draft returned', async () => {
    st.merge = () => ({ ok: false, error: 'PR failed' });
    await run();
    assert.ok(calls.includes('recordMergeFailure:PR failed'));
    assert.ok(!names().includes('markDraftPrOpened'));
  });

  test('a CMS change waits for a person to publish it (no PR state)', async () => {
    st.merge = () => ({ ok: true, awaitingHumanPublish: true, cmsDocumentId: 'doc-1', cmsReviewUrl: 'https://cms/doc-1' });
    const out = await run();
    assert.equal(out.status, 'awaiting_publish');
  });

  test('nothing in this function merges a pull request', async () => {
    await run();
    assert.ok(!calls.some((c) => /merge(PullRequest|Pr)\b|^merge:/.test(c)), 'mergeToStage opens a PR; there is no merge call');
  });
});
