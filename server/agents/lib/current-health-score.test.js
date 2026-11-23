import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// command-center.js (where categoryByAgentId lives) pulls a heavy chain of its own; the helper's collaborators are injected, so it is
// replaced with the one function the helper imports from it.
mock.module(new URL('./command-center.js', import.meta.url).href, { namedExports: { categoryByAgentId: async () => new Map() } });
const { computeCurrentHealthScore } = await import('./current-health-score.js');
const { computeHealthScore } = await import('./health-score.js');
const { HEALTH_SCORE_AGENT_IDS, RECOMMENDATION_AGENT_IDS } = await import('./insights.js');

const f = (id, priority, value = 10) => ({ id, priority, expectedImpact: { value }, whyItMatters: 'x' });

describe('computeCurrentHealthScore', () => {
  test('reads every score agent\'s latest findings, tags each with its agent, and scores them weighted by category', async () => {
    let askedFor;
    const runs = [{ agentId: 'security-headers', findings: [f('s1', 'high')] }, { agentId: 'content-gap', findings: [f('c1', 'high')] }];
    const cats = new Map([['security-headers', { category: 'security' }], ['content-gap', { category: 'content' }]]);
    const r = await computeCurrentHealthScore(7, {
      getLatestFindings: async (siteId, ids) => { askedFor = [siteId, ids]; return runs; },
      getImplementedFindingIds: async () => new Set(),
      categoryByAgentId: async () => cats,
    });
    assert.deepEqual(askedFor, [7, HEALTH_SCORE_AGENT_IDS]);
    const expected = computeHealthScore(runs.flatMap((x) => x.findings.map((y) => ({ ...y, agentId: x.agentId }))), new Set(), cats);
    assert.deepEqual(r, expected);
    // and the weights matter: the same findings without the category map score differently
    const unweighted = computeHealthScore(runs.flatMap((x) => x.findings.map((y) => ({ ...y, agentId: x.agentId }))), new Set(), new Map());
    assert.notEqual(r.score, unweighted.score, 'this is exactly the difference the nightly job used to miss');
  });

  test('a fix that already went live no longer counts against the score', async () => {
    const runs = [{ agentId: 'technical-seo', findings: [f('a', 'high'), f('b', 'high')] }];
    const base = { getLatestFindings: async () => runs, categoryByAgentId: async () => new Map() };
    const open = await computeCurrentHealthScore(1, { ...base, getImplementedFindingIds: async () => new Set() });
    const fixed = await computeCurrentHealthScore(1, { ...base, getImplementedFindingIds: async () => new Set(['a']) });
    assert.ok(fixed.score > open.score);
  });

  test('no findings: a perfect score', async () => {
    const r = await computeCurrentHealthScore(1, { getLatestFindings: async () => [], getImplementedFindingIds: async () => new Set(), categoryByAgentId: async () => new Map() });
    assert.equal(r.score, 100);
  });
});

describe('one definition, no second copy', () => {
  test('the score agents are every recommendation agent plus geo-audit, once', () => {
    assert.deepEqual(HEALTH_SCORE_AGENT_IDS, [...RECOMMENDATION_AGENT_IDS, 'geo-audit']);
    assert.equal(new Set(HEALTH_SCORE_AGENT_IDS).size, HEALTH_SCORE_AGENT_IDS.length);
  });
  test('neither writer of the daily score computes its own: the nightly job uses the helper and Command Center the shared list', () => {
    const root = new URL('../../', import.meta.url);
    const job = readFileSync(new URL('job.js', root), 'utf8');
    const cc = readFileSync(new URL('agents/lib/command-center.js', root), 'utf8');
    assert.match(job, /computeCurrentHealthScore\(site\.id\)/);
    assert.doesNotMatch(job, /computeHealthScore\(/, 'job.js must not compute the score itself');
    assert.match(cc, /getLatestFindings\(siteId, HEALTH_SCORE_AGENT_IDS\)/);
    assert.doesNotMatch(cc, /\[\.\.\.RECOMMENDATION_AGENT_IDS, 'geo-audit'\]/, 'Command Center must not keep its own copy of the list');
  });
});
