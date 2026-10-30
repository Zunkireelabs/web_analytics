import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// pick-runner imports the real action-center route and stores; the job itself is driven entirely through injected fakes.
mock.module('../../routes/action-center.js', { namedExports: { generateDraft: async () => { throw new Error('real generateDraft must not run'); }, approveAndPublishDraftUnattended: async () => { throw new Error('real publish must not run'); } } });
mock.module('../../store/content-picks.js', { namedExports: { listSavedPicks: async () => [], setPickStatus: async () => null, claimPickDay: async () => true, releaseStuckBuilding: async () => 0 } });
mock.module('../../store/recommendations.js', { namedExports: { getRecommendationByFindingId: async () => null } });
mock.module('../../store/drafts.js', { namedExports: { submitDraftForApproval: async () => null, updateDraft: async () => null } });
mock.module('../../store/design-choices.js', { namedExports: { listChosenDesignChoices: async () => [], markDesignChoiceStatus: async () => null } });

const { buildSavedContentPicks, buildChosenDesignChoices, buildApprovedForToday } = await import('./pick-runner.js');
const { instructionFor } = await import('../../lib/content-options.js');

const site = { id: 7, repo_owner: 'acme', repo_name: 'site' };
const pick = (over = {}) => ({ finding_id: 'f1', generator_id: 'landing-page', option_key: 'B', chosen_by: 42, ...over });

function harness({ picks = [pick()], rec = { params: { topic: 'Free valuation' } }, draft = { id: 9, status: 'draft' }, submit = true, generate, publish } = {}) {
  const log = { status: [], generate: [], publish: [] };
  const deps = {
    listSavedPicks: async () => picks,
    setPickStatus: async (_s, id, to) => { log.status.push([id, to]); return { finding_id: id, status: to }; },
    getRecommendationByFindingId: async () => rec,
    generateDraft: generate || (async (_s, args) => { log.generate.push(args); return draft; }),
    submitDraftForApproval: async () => (submit ? { id: draft.id } : null),
    approveAndPublishDraftUnattended: publish || (async (_s, id, opts) => { log.publish.push([id, opts]); return {}; }),
  };
  return { deps, log };
}

test('the chosen option becomes an instruction naming it, and only valid options get one', () => {
  assert.match(instructionFor('landing-page', 'B'), /"Form first"/);
  assert.match(instructionFor('translation', 'C'), /"Shorter wording"/);
  assert.equal(instructionFor('landing-page', 'Z'), null);
  assert.equal(instructionFor('security-headers', 'A'), null);
});

test('a saved pick is generated with its option, approved as the person who chose it, and marked shipped', async () => {
  const { deps, log } = harness();
  const out = await buildSavedContentPicks(site, deps);
  assert.deepEqual(out, { built: 1, withdrawn: 0, retryLater: 0, left: 0, skipped: null });
  assert.deepEqual(log.status, [['f1', 'building'], ['f1', 'shipped']]);
  assert.equal(log.generate[0].findingId, 'f1');
  assert.equal(log.generate[0].generatorId, 'landing-page');
  assert.equal(log.generate[0].params.topic, 'Free valuation', 'the idea\'s own parameters are kept');
  assert.match(log.generate[0].params.designCorrections, /"Form first"/, 'the chosen option reaches the generator');
  assert.deepEqual(log.publish[0], [9, { userId: 42, deferPr: false }]);
});

test('a draft that already shipped is not generated or published twice', async () => {
  const { deps, log } = harness({ draft: { id: 9, status: 'pr_opened' } });
  const out = await buildSavedContentPicks(site, deps);
  assert.equal(out.built, 1);
  assert.equal(log.publish.length, 0);
});

test('a draft someone is reviewing is left alone and the pick is put back', async () => {
  const { deps, log } = harness({ draft: { id: 9, status: 'submitted_for_approval' } });
  const out = await buildSavedContentPicks(site, deps);
  assert.equal(out.left, 1);
  assert.equal(log.publish.length, 0);
  assert.deepEqual(log.status.at(-1), ['f1', 'saved']);
});

test('a pick that cannot be built is withdrawn; a temporary failure is retried next run; one failing never stops the others', async () => {
  let n = 0;
  const { deps, log } = harness({
    picks: [pick({ finding_id: 'a' }), pick({ finding_id: 'b' }), pick({ finding_id: 'c' })],
    generate: async (_s, args) => { n += 1; if (args.findingId === 'a') throw new Error('Landing page generation failed: model did not return valid JSON'); if (args.findingId === 'b') throw new Error('GitHub rate limit hit'); return { id: 3, status: 'draft' }; },
  });
  const out = await buildSavedContentPicks(site, deps);
  assert.deepEqual([out.built, out.withdrawn, out.retryLater], [1, 1, 1]);
  assert.equal(n, 3, 'all three were tried');
  assert.ok(log.status.some(([id, to]) => id === 'a' && to === 'withdrawn'));
  assert.ok(log.status.some(([id, to]) => id === 'b' && to === 'saved'));
  assert.ok(log.status.some(([id, to]) => id === 'c' && to === 'shipped'));
});

test('a pick whose idea no longer exists is withdrawn, and a site with no repository is skipped untouched', async () => {
  const { deps, log } = harness({ rec: null });
  assert.equal((await buildSavedContentPicks(site, deps)).withdrawn, 1);
  assert.deepEqual(log.status, [['f1', 'withdrawn']]);
  const none = harness();
  assert.equal((await buildSavedContentPicks({ id: 7 }, none.deps)).skipped, 'no-repository');
  assert.equal(none.log.status.length, 0);
});

// ── chosen DESIGN CHOICES on fixes: the picked template is set on the draft and the same publish chain runs ─────────────
const choice = (over = {}) => ({ id: 3, finding_id: 'f-faq', generator_id: 'faq', chosen_option: 'qaContent', ...over });

function designHarness({ choices = [choice()], rec = { params: { page: 'https://demo.example/services' } }, draft = { id: 9, status: 'draft', content: { items: [1] } }, generate, publish } = {}) {
  const log = { status: [], updates: [], publish: [] };
  const deps = {
    listChosenDesignChoices: async () => choices,
    markDesignChoiceStatus: async (_s, id, to) => { log.status.push([id, to]); return { id, status: to }; },
    getRecommendationByFindingId: async () => rec,
    generateDraft: generate || (async () => draft),
    updateDraft: async (_s, id, patch) => { log.updates.push([id, patch.content]); return { id, content: patch.content }; },
    submitDraftForApproval: async () => ({ id: draft.id }),
    approveAndPublishDraftUnattended: publish || (async (_s, id) => { log.publish.push(id); return {}; }),
  };
  return { deps, log };
}

test('a chosen layout is set on the draft as designTemplate, then the normal publish chain runs, and the choice is marked shipped', async () => {
  const { deps, log } = designHarness();
  const out = await buildChosenDesignChoices(site, deps);
  assert.deepEqual(out, { built: 1, backToPerson: 0, retryLater: 0, skipped: null });
  assert.deepEqual(log.status, [[3, 'building'], [3, 'shipped']]);
  assert.deepEqual(log.updates[0], [9, { items: [1], designTemplate: 'qaContent' }], 'the site\'s own template the person picked');
  assert.deepEqual(log.publish, [9]);
});

test('a layout that still cannot be built goes back to the person; a temporary failure is retried; the others still run', async () => {
  const { deps, log } = designHarness({
    choices: [choice({ id: 1, finding_id: 'a' }), choice({ id: 2, finding_id: 'b' }), choice({ id: 3, finding_id: 'c' })],
    generate: async (_s, args) => { if (args.findingId === 'a') throw new Error('Quality gate failed'); if (args.findingId === 'b') throw new Error('GitHub rate limit'); return { id: 9, status: 'draft', content: {} }; },
  });
  const out = await buildChosenDesignChoices(site, deps);
  assert.deepEqual([out.built, out.backToPerson, out.retryLater], [1, 1, 1]);
  assert.ok(log.status.some(([id, to]) => id === 1 && to === 'needs_choice'), 'asked again');
  assert.ok(log.status.some(([id, to]) => id === 2 && to === 'chosen'), 'kept for the next run');
});

test('a draft someone is reviewing is left alone, and a site with no repository is skipped', async () => {
  const reviewing = designHarness({ draft: { id: 9, status: 'submitted_for_approval', content: {} } });
  await buildChosenDesignChoices(site, reviewing.deps);
  assert.equal(reviewing.log.publish.length, 0);
  assert.deepEqual(reviewing.log.status.at(-1), [3, 'chosen']);
  assert.equal((await buildChosenDesignChoices({ id: 7 }, designHarness().deps)).skipped, 'no-repository');
});

// ── once a day: approving only saves; the daily run builds, and an approval made after it waits for tomorrow ───────────
test('the first run of the day builds both the content picks and the chosen design choices, and recovers anything left half-built first', async () => {
  const calls = [];
  const out = await buildApprovedForToday({ id: 7, timezone: 'Asia/Kathmandu' }, {
    todayInTz: (tz) => { calls.push(['day', tz]); return '2026-10-30'; },
    releaseStuckBuilding: async () => { calls.push(['release']); return 0; },
    claimPickDay: async (id, day) => { calls.push(['claim', id, day]); return true; },
    buildSavedContentPicks: async () => { calls.push(['picks']); return { built: 2 }; },
    buildChosenDesignChoices: async () => { calls.push(['choices']); return { built: 1 }; },
  });
  assert.deepEqual(calls.map((c) => c[0]), ['release', 'day', 'claim', 'picks', 'choices']);
  assert.deepEqual(calls.find((c) => c[0] === 'day'), ['day', 'Asia/Kathmandu'], 'the day is the project\'s own local day');
  assert.deepEqual(out, { day: '2026-10-30', picks: { built: 2 }, choices: { built: 1 } });
});

test('a second run the same day (the catch-up guard, say) builds nothing, so an approval made after the first run waits for tomorrow', async () => {
  let built = 0;
  const out = await buildApprovedForToday({ id: 7 }, {
    todayInTz: () => '2026-10-30', releaseStuckBuilding: async () => 0,
    claimPickDay: async () => false,                       // today was already claimed by the earlier run
    buildSavedContentPicks: async () => { built += 1; return {}; }, buildChosenDesignChoices: async () => { built += 1; return {}; },
  });
  assert.deepEqual(out, { skipped: 'already-built-today', day: '2026-10-30' });
  assert.equal(built, 0, 'nothing is built, so no second commit lands on top of today\'s');
});
