import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER } from './design-repair.js';
import { tenantLessonRecorder, sharedEvidenceText, buildHandoffs } from './design-repair-wiring.js';

const diagnosis = {
  owner: OWNER.SHARED_RENDERER,
  cause: 'the site\'s body elements carry classes (post-text) that the rendered markup does not',
  evidence: ['classes on the site\'s body elements that the draft lacks: post-text, post-h2', 'body region on the site: div.post < main'],
};
const failure = {
  reason: 'render-deviation',
  referenceUrl: 'https://acme-client.example/blog/our-secret-launch/',
  deviations: [{ kind: 'line-length', expected: 64, actual: 160, viewport: 'desktop' }],
};
const draft = { id: 41, action_type: 'direct-answer', input: { page: '/blog/x/' } };

test('tenantLessonRecorder: a repair that held is recorded as a FIX for this tenant, with what was tried', async () => {
  const calls = [];
  const learn = tenantLessonRecorder({ siteId: 7, draft, recordFix: async (s, p) => calls.push(['fix', s, p]), recordFailure: async (s, p) => calls.push(['anti', s, p]) });
  await learn({ outcome: 'fixed', diagnosis, attempts: [{ owner: 'generator', action: 'regenerate', outcome: 'passed the re-check' }], failure });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'fix');
  assert.equal(calls[0][1], 7);
  assert.equal(calls[0][2].patternId, 'render-deviation');
  assert.equal(calls[0][2].validation.passed, true);
  assert.match(calls[0][2].correction, /Repaired automatically/);
  assert.match(calls[0][2].detail, /post-text/, 'tenant-scoped lessons keep the site\'s own specifics');
});

test('tenantLessonRecorder: a repair that did not hold is an ANTI-PATTERN so it is not repeated', async () => {
  const calls = [];
  const learn = tenantLessonRecorder({ siteId: 7, draft, recordFix: async () => calls.push('fix'), recordFailure: async (s, p) => calls.push(p) });
  await learn({ outcome: 'exhausted', diagnosis, attempts: [], failure });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].validation.passed, false);
  assert.match(calls[0].correction, /Did not hold/);
});

test('tenantLessonRecorder: the layout verdict keeps its own pattern', async () => {
  const calls = [];
  const learn = tenantLessonRecorder({ siteId: 1, draft, recordFix: async (s, p) => calls.push(p), recordFailure: async () => {} });
  await learn({ outcome: 'fixed', diagnosis, attempts: [], failure: { reason: 'responsive-regression' } });
  assert.equal(calls[0].patternId, 'responsive-regression');
});

test('THE WALL: shared engineering evidence carries no client class, URL or copy', () => {
  const text = sharedEvidenceText(diagnosis, failure);
  assert.doesNotMatch(text, /post-text|post-h2/);
  assert.doesNotMatch(text, /acme-client|our-secret-launch|https?:\/\//);
  assert.match(text, /line-length/);
  assert.match(text, /lost structure/);
  assert.ok(text.length <= 480);
});

test('THE WALL: a gate fault is described as a check fault, still with no identifying detail', () => {
  const text = sharedEvidenceText({ owner: OWNER.VALIDATION_GATE, cause: 'x', evidence: ['body region on the site: div.client-secret-wrapper'] }, failure);
  assert.match(text, /does not reproduce/);
  assert.doesNotMatch(text, /client-secret-wrapper|acme-client/);
});

test('buildHandoffs.designCapture asks the Design Agent for a re-capture of THIS site, and says someone took it', async () => {
  const seen = [];
  const h = buildHandoffs({ site: { id: 7 }, draft, requestRefresh: async (s) => { seen.push(s.id); return { queued: true, reason: 'diagnosed-design-capture-gap' }; } });
  const r = await h.designCapture();
  assert.equal(r.requested, true);
  assert.match(r.detail, /diagnosed-design-capture-gap/);
  assert.deepEqual(seen, [7]);
});

test('designCapture: a re-capture already queued, or just done, counts as in hand; no repo / error does NOT', async () => {
  for (const [reason, inHand] of [['already-queued', true], ['cooldown', true], ['no-repo', false], ['no-page-url', false], ['error', false]]) {
    const h = buildHandoffs({ site: { id: 7 }, draft, requestRefresh: async () => ({ queued: false, reason }) });
    assert.equal((await h.designCapture()).requested, inHand, reason);
  }
});

test('buildHandoffs.sharedCode hands the engineering agent ONE root-cause task: site-less, generic, pointed at the right files and test', async () => {
  const seen = [];
  const h = buildHandoffs({ site: { id: 7 }, draft, accept: async (task) => { seen.push(task); return { accepted: true, reason: 'started' }; } });
  const r = await h.sharedCode(diagnosis, failure);
  assert.equal(r.requested, true);
  assert.match(r.detail, /started/);
  const t = seen[0];
  assert.equal(t.generatorId, 'direct-answer');
  assert.equal(t.owner, OWNER.SHARED_RENDERER);
  assert.equal(t.testFileHint, 'server/implementers/lib/newpage-render.test.js');
  assert.match(t.errorMessage, /Start in: server\/implementers\/lib\/newpage-render\.js/);
  assert.doesNotMatch(t.errorMessage, /post-text|acme-client|our-secret-launch/);
});

test('a validation-gate fault points the engineering agent at the gate, not the renderer', async () => {
  const seen = [];
  const h = buildHandoffs({ site: { id: 7 }, draft, accept: async (task) => { seen.push(task); return { accepted: true, reason: 'started' }; } });
  await h.sharedCode({ owner: OWNER.VALIDATION_GATE, cause: 'x', evidence: [] }, failure);
  assert.equal(seen[0].testFileHint, 'server/design-agent/live-analysis/body-measure.browser.test.js');
  assert.match(seen[0].errorMessage, /body-measure\.js/);
});

test('every way a hand-off can be refused is reported as NOT requested, with its real reason', async () => {
  for (const reason of ['disabled', 'already-flagged-for-human-review', 'lookup-failed', 'no-reason']) {
    const h = buildHandoffs({ site: { id: 7 }, draft, accept: async () => ({ accepted: false, reason }) });
    const r = await h.sharedCode(diagnosis, failure);
    assert.equal(r.requested, false, reason);
    assert.match(r.detail, new RegExp(reason));
  }
});

test('every way a hand-off can be taken is reported as requested', async () => {
  for (const reason of ['started', 'already-in-progress', 'repair-already-proposed']) {
    const h = buildHandoffs({ site: { id: 7 }, draft, accept: async () => ({ accepted: true, reason }) });
    assert.equal((await h.sharedCode(diagnosis, failure)).requested, true, reason);
  }
});
