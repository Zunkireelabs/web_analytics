import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { defaultStages, candidatesFromSelection } from './stages.js';
import { STAGES, pipelineConfig } from './config.js';

const site = { id: 5, name: 'Acme', url_file_map: { siteRoot: { designProfile: {} } } };
const cfg = pipelineConfig({});
const build = (deps) => defaultStages({ config: cfg, startOfDayMs: 0, analystWaitUntilMs: 0, liveDesignFromMs: 0, deps });
const stage = (stages, name) => stages.find((s) => s.name === name);

describe('every stage is wired and in the documented order', () => {
  test('the stage list matches STAGES, and none reports "not-wired"', async () => {
    const stages = build({});
    assert.deepEqual(stages.map((s) => s.name), [...STAGES]);
    for (const s of stages) assert.ok(!String(s.run).includes('not-wired'), `${s.name} is a placeholder`);
  });
  test('repair runs after the analyst stage (it must see the freshly synced recommendations) and before generate', () => {
    assert.ok(STAGES.indexOf('analyst') < STAGES.indexOf('repair') && STAGES.indexOf('repair') < STAGES.indexOf('generate'));
    assert.ok(STAGES.indexOf('generate') < STAGES.indexOf('design-live') && STAGES.indexOf('design-live') < STAGES.indexOf('prepare'));
  });
});

describe('generate = candidate selection into the queue, no drafts', () => {
  const ctx = { queue: [
    { rec: { id: 11, recommendation_type: 'meta-title', finding_ids: ['f1'], params: { page: 'https://a.com/' } }, score: 9, lane: 'analytics' },
    { rec: { id: 12, recommendation_type: 'qa-content', finding_ids: [], params: { page: 'https://a.com/x' } }, score: 5, lane: 'analyst' },
  ], selectionDeferred: [1, 2, 3] };
  test('queues exactly the selected items, as the auto-remediation source (so the daily ceiling counts them)', async () => {
    const enqueued = [];
    const stages = build({
      '../../agents/lib/auto-remediation.js': { selectRemediationCandidates: async () => ({ ctx }) },
      '../../store/shipping-queue.js': { enqueue: async (id, c) => { enqueued.push({ id, ...c }); } },
    });
    const out = await stage(stages, 'generate').run({ site });
    assert.equal(out.selected, 2); assert.equal(out.deferred, 3);
    assert.deepEqual(enqueued.map((e) => [e.id, e.source, e.generatorId, e.recommendationId, e.findingId, e.lane]),
      [[5, 'auto-remediation', 'meta-title', 11, 'f1', 'analytics'], [5, 'auto-remediation', 'qa-content', 12, null, 'analyst']]);
  });
  test('when the selection ends the run (disabled, onboarding pending, no budget) nothing is queued and the reason is kept', async () => {
    let n = 0;
    const stages = build({
      '../../agents/lib/auto-remediation.js': { selectRemediationCandidates: async () => ({ done: { stoppedReason: 'budget-exhausted' } }) },
      '../../store/shipping-queue.js': { enqueue: async () => { n++; } },
    });
    const out = await stage(stages, 'generate').run({ site });
    assert.equal(n, 0); assert.equal(out.skip, 'budget-exhausted');
  });
  test('candidatesFromSelection keeps the selection order', () => {
    assert.deepEqual(candidatesFromSelection(ctx).map((c) => c.recommendationId), [11, 12]);
  });
});

describe('prepare claims only the auto-remediation lane and never approves or pushes', () => {
  test('claim is restricted to the auto-remediation source; prepared items are marked prepared; no approve/push function is even provided', async () => {
    let claimedWith = null; const marked = [];
    const stages = build({
      '../../store/drafts.js': { submitDraftForApproval: async () => {}, markDraftAbandoned: async () => {} },
      '../../routes/action-center.js': { generateDraft: async () => ({ id: 'd1' }), validateDraft: async () => ({ draft: { id: 'd1' } }) },
      '../../store/shipping-queue.js': {
        enqueue: async () => {}, markPrepared: async (id) => { marked.push(id); return true; }, releaseItem: async () => {},
        claimForPreparation: async (siteId, o) => { claimedWith = o; return [{ id: 1, generator_id: 'meta-title', params: { page: 'https://a.com/' }, source: 'auto-remediation', finding_id: 'f1' }]; },
      },
      '../../implementers/lib/design-drift.js': { siteHasUsableDesignProfile: () => true },
      '../../job.js': { queueDesignAgentDerivationForSite: async () => false },
    });
    const out = await stage(stages, 'prepare').run({ site, deadlineAt: null, isAborted: () => false });
    assert.deepEqual(claimedWith.sources, ['auto-remediation']);
    assert.deepEqual(marked, [1]); assert.equal(out.prepared, 1);
  });
});

describe('repair: every step runs, and the stage is only done when all succeeded', () => {
  const ok = (name, log) => async () => { log.push(name); return {}; };
  const deps = (log, failing = null) => ({
    '../../job.js': { runAiVisibilityShipForAllSites: async () => { log.push('ai'); } },
    '../../scripts/repair-design-profile-roles.js': { repairDesignProfileRolesForSites: ok('roles', log) },
    '../../scripts/repair-site-content-live.js': { repairSiteContentLive: failing === 'content' ? async () => { throw new Error('GitHub 502'); } : ok('content', log) },
    '../../scripts/repair-template-capability.js': { repairTemplateCapabilitiesForSite: ok('template', log) },
    '../../agents/lib/faq-onboarding-check.js': { checkFaqOnboardingCoverage: ok('faq', log) },
    '../../agents/lib/recommendation-coordinator.js': { refreshBlockedRecommendations: ok('refresh', log) },
  });
  test('the original order is kept: role correction, content repair, template capability, FAQ, blocked refresh, AI visibility', async () => {
    const log = []; await stage(build(deps(log)), 'repair').run({ site });
    assert.deepEqual(log, ['roles', 'content', 'template', 'faq', 'refresh', 'ai']);
  });
  test('one failing step does not skip the others, but the stage FAILS (never silently successful)', async () => {
    const log = [];
    await assert.rejects(stage(build(deps(log, 'content')), 'repair').run({ site }), /repair steps failed: content-repair/);
    assert.deepEqual(log, ['roles', 'template', 'faq', 'refresh', 'ai']);
  });
});
