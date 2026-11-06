import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { projectMemoryToEvidence, behaviourToEvidence, industryToEvidence, MAX_BEHAVIOUR_ITEMS, MAX_INDUSTRY_ITEMS, learningEvidenceEnabled } from './learning-evidence.js';
import { createEvidenceGatherer } from '../agents/lib/decision-evidence.js';

const sec = (status, data, freshness = 'fresh') => ({ status, data, provenance: { freshness, asOf: '2026-11-01', sources: [] } });
const memory = {
  siteId: 7,
  sections: {
    business: sec('ok', { industries: ['education'], goals: [1, 2] }),
    technical: sec('ok', { repoConnected: false }),
    design: sec('ok', { profilePresent: true, usable: false, captureGaps: [1] }, 'stale'),
    search: sec('empty', null),
    history: sec('ok', { drafts: { total: 4, implemented: 1 } }),
  },
};

describe('project memory as evidence', () => {
  const ev = projectMemoryToEvidence(memory);
  test('states the facts that change what is safe, and flags stale ones', () => {
    const text = ev.map((e) => e.summary).join('\n');
    assert.match(text, /NOT connected/);
    assert.match(text, /NOT usable, so visible changes are unsafe/);
    assert.match(text, /this information is stale/);
  });
  test('an empty section says "do not assume", never invents', () => {
    assert.ok(ev.some((e) => /Nothing is recorded yet for this project's search/.test(e.summary)));
  });
  test('null memory gives nothing', () => assert.deepEqual(projectMemoryToEvidence(null), []));
});

describe('behaviour learning as evidence', () => {
  const g = (id, tech, imp, o = {}) => ({ generatorId: id, technicalEvidence: tech, impactEvidence: imp, demoted: false, text: `${id}: text`, counts: {}, ...o });
  test('caps items, puts held and established first, and folds thin history into one honest line', () => {
    const gens = [g('thin1', 'insufficient', 'insufficient'), g('thin2', 'insufficient', 'none'), g('est', 'established', 'limited'), g('held', 'limited', 'insufficient', { demoted: true }),
      ...Array.from({ length: 8 }, (_, i) => g(`lim${i}`, 'limited', 'insufficient'))];
    const ev = behaviourToEvidence({ generators: gens }, 7);
    assert.ok(ev.length <= MAX_BEHAVIOUR_ITEMS + 1);
    assert.equal(ev[0].meta.generatorId, 'held');
    assert.equal(ev[1].meta.generatorId, 'est');
    assert.match(ev.at(-1).summary, /too little history/);
    assert.ok(ev.every((e) => /\[evidence:|too little history/.test(e.summary)));
  });
  test('generators with no history at all are not mentioned as if they had some', () => {
    assert.deepEqual(behaviourToEvidence({ generators: [g('none', 'none', 'none')] }, 7), []);
  });
});

describe('industry knowledge as evidence', () => {
  const item = (o) => ({ industry: 'education', subIndustry: '', kind: 'generator-outcome', subject: 's', claim: 'a claim', status: 'validated', label: 'validated', confidence: 'medium', evidence: { sites: 4 }, ...o });
  test('validated, contradicted and starting-point items are worded differently so convention is never read as proof', () => {
    const ev = industryToEvidence({
      classified: true,
      validated: [item({ subject: 'v' })],
      contradicted: [item({ subject: 'c', status: 'contradicted', label: 'contradicted' })],
      startingPoints: [item({ subject: 'p', kind: 'practice', status: 'candidate', label: 'starting-point' })],
    }, 7);
    const by = (s) => ev.find((e) => e.meta.subject === s).summary;
    assert.match(by('v'), /validated across projects/);
    assert.match(by('c'), /DISAGREE - do not rely/);
    assert.match(by('p'), /NOT confirmed by results/);
  });
  test('capped, and an unclassified project contributes nothing', () => {
    const many = Array.from({ length: 12 }, (_, i) => item({ subject: `v${i}` }));
    assert.ok(industryToEvidence({ classified: true, validated: many, contradicted: [], startingPoints: [] }, 7).length <= MAX_INDUSTRY_ITEMS);
    assert.deepEqual(industryToEvidence({ classified: false }, 7), []);
  });
  test('no tenant identifiers are placed in the evidence beyond the asking project\'s own id in refs', () => {
    const blob = JSON.stringify(industryToEvidence({ classified: true, validated: [item({})], contradicted: [], startingPoints: [] }, 7));
    assert.ok(!/site_id|workspace/i.test(blob));
  });
});

describe('wired into the existing evidence gatherer', () => {
  const base = { listOpenRecommendationsFn: async () => [], findRelevantMemoryFn: async () => [], fetchInvestigationEvidenceFn: async () => [], listFindingsFn: async () => [], listDecisionsForSiteFn: async () => [] };
  const loaders = {
    projectMemory: async () => [{ source: 'project-memory', summary: 'm', ref: 'm' }],
    behaviour: async () => { throw new Error('boom'); },
    industry: async () => [{ source: 'industry-intelligence', summary: 'i', ref: 'i' }],
  };
  test('off: exactly the evidence it gathered before', async () => {
    const g = createEvidenceGatherer({ ...base, learningLoaders: loaders, learningEnabledFn: () => false });
    assert.deepEqual(await g.gatherCorrelatedEvidence('generic', 7), []);
  });
  test('on: adds the layers, and one failing layer does not block the others', async () => {
    const g = createEvidenceGatherer({ ...base, learningLoaders: loaders, learningEnabledFn: () => true });
    const ev = await g.gatherCorrelatedEvidence('technical_issue', 7);
    assert.deepEqual(ev.map((e) => e.ref), ['m', 'i']);
  });
  test('flag reads LEARNING_EVIDENCE_IN_DECISIONS only', () => {
    assert.equal(learningEvidenceEnabled({}), true, 'unset means on');
    assert.equal(learningEvidenceEnabled({ LEARNING_EVIDENCE_IN_DECISIONS: 'off' }), false);
    assert.equal(learningEvidenceEnabled({ LEARNING_EVIDENCE_IN_DECISIONS: 'on' }), true);
  });
});
