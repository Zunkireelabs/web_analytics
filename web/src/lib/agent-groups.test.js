import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_GROUPS, AGENT_AREAS, groupIdFor, buildGroups, buildAreas, runProgress, currentArea, browseTarget, isAgentPath } from './agent-groups.js';

const a = (id, category, extra = {}) => ({ id, name: id, category, lastRunStatus: 'ok', lastRunAt: '2026-11-20T08:00:00Z', lastRunFindings: 1, ...extra });

describe('the six groups', () => {
  test('exactly six, each with a plain blurb', () => {
    assert.equal(AGENT_GROUPS.length, 6);
    assert.deepEqual(AGENT_GROUPS.map((g) => g.id), ['seo', 'geo', 'content', 'executive', 'accessibility', 'security']);
    assert.ok(AGENT_GROUPS.every((g) => g.blurb.length > 20));
  });
  test('every category the system uses has a home; an unknown one goes to SEO', () => {
    for (const [cat, id] of [['seo', 'seo'], ['technical', 'seo'], ['on-page', 'seo'], ['geo', 'geo'], ['content', 'content'], ['meta', 'executive'], ['accessibility', 'accessibility'], ['security', 'security'], ['compliance', 'security']]) {
      assert.equal(groupIdFor(cat), id, cat);
    }
    assert.equal(groupIdFor('something-new'), 'seo');
  });
});

describe('building the groups', () => {
  const agents = [a('x', 'seo'), a('y', 'technical', { lastRunStatus: 'error' }), a('g', 'geo'), a('c', 'content', { lastRunStatus: null, lastRunAt: null })];
  test('agents are counted in their group and groups with none are left out', () => {
    const gs = buildGroups(agents, new Map());
    assert.deepEqual(gs.map((g) => g.id), ['seo', 'geo', 'content']);
    assert.equal(gs[0].total, 2);
  });
  test('running comes from the live map; a failed agent marks attention', () => {
    const gs = buildGroups(agents, new Map([['g', 1]]));
    assert.equal(gs.find((g) => g.id === 'geo').state, 'running');
    assert.equal(gs.find((g) => g.id === 'geo').runningCount, 1);
    assert.equal(gs.find((g) => g.id === 'seo').state, 'attention');
    assert.equal(gs.find((g) => g.id === 'content').state, 'ok');
  });
  test('findings add up and last run is the newest in the group', () => {
    const gs = buildGroups([a('p', 'seo', { lastRunAt: '2026-11-19T08:00:00Z', lastRunFindings: 2 }), a('q', 'seo', { lastRunAt: '2026-11-20T09:00:00Z', lastRunFindings: 3 })], new Map());
    assert.equal(gs[0].findings, 5);
    assert.equal(gs[0].lastRunAt, '2026-11-20T09:00:00.000Z');
  });
  test('no agents loaded yet gives no groups', () => assert.deepEqual(buildGroups(null, new Map()), []));
});

describe('going back to Browse', () => {
  test('returns to the page the client was on, else Overview', () => {
    assert.equal(browseTarget('/keywords'), '/keywords');
    assert.equal(browseTarget(null), '/overview');
    assert.equal(browseTarget('/ai-orchestration'), '/overview');
    assert.equal(browseTarget('/ai-orchestration?group=seo'.split('?')[0]), '/overview');
  });
  test('agent paths are recognised', () => {
    assert.ok(isAgentPath('/ai-orchestration'));
    assert.ok(!isAgentPath('/ai-visibility'));
  });
});

// Every specialist the registry lists (checked 2026-11-20 against listAgentMeta) and the group its category puts it in.
const REGISTRY = { seo: ['authority', 'competitor-intelligence', 'device-intelligence', 'duplicate-content', 'internal-linking', 'keyword-narrative', 'mobile-usability', 'opportunity', 'prospect-discovery', 'query-intelligence', 'technical-seo', 'templated-duplicates', 'visitor-behaviour', 'cta-analysis', 'gsc-url-audit', 'query-param-duplicates', 'redirect-chain', 'sitemap-conflict', 'sitemap', 'soft-404', 'url-variant-duplicates'],
  geo: ['ai-visibility', 'country-intelligence', 'geo-signals', 'growth-queries'], content: ['ai-recommendation', 'blog-image', 'comparison-opportunity', 'content-gap', 'content-integrity', 'font-consistency', 'news-posts', 'trend-radar', 'visual-quality'],
  executive: ['executive-report'], accessibility: ['accessibility'], security: ['security-headers', 'trust-compliance'] };

describe('areas: what each agent looks after', () => {
  test('every real specialist belongs to exactly one area of its own agent', () => {
    for (const [gid, ids] of Object.entries(REGISTRY)) {
      const inAreas = (AGENT_AREAS[gid] || []).flatMap((a) => a.agents);
      assert.deepEqual([...inAreas].sort(), [...ids].sort(), gid);
    }
  });
  test('no area names a specialist twice across the six agents', () => {
    const all = Object.values(AGENT_AREAS).flatMap((as) => as.flatMap((a) => a.agents));
    assert.equal(new Set(all).size, all.length);
  });
  const ag = (id, category, extra = {}) => ({ id, name: id, category, lastRunStatus: 'ok', lastRunAt: '2026-11-20T08:00:00Z', lastRunFindings: 0, ...extra });
  test('an area runs while any of its specialists runs; waiting while queued; never if none ever ran', () => {
    const gs = buildGroups([ag('technical-seo', 'seo'), ag('mobile-usability', 'seo'), ag('internal-linking', 'seo', { lastRunStatus: null, lastRunAt: null })], new Map([['technical-seo', 1]]));
    const areas = buildAreas(gs[0], new Set(['internal-linking']));
    assert.equal(areas.find((a) => a.name === 'Titles, speed and phones').state, 'running');
    assert.equal(areas.find((a) => a.name === 'Links between your pages').state, 'waiting');
    assert.equal(areas.find((a) => a.name === 'Sitemap and indexing').state, 'never');
    assert.equal(currentArea(areas).name, 'Titles, speed and phones');
  });
  test('findings add up per area', () => {
    const gs = buildGroups([ag('sitemap', 'technical', { lastRunFindings: 2 }), ag('soft-404', 'technical', { lastRunFindings: 1 }), ag('sitemap-conflict', 'technical', { lastRunFindings: 3 })], new Map());
    const areas = buildAreas(gs[0]);
    assert.equal(areas.find((a) => a.name === 'Sitemap and indexing').found, 5);
    assert.equal(areas.find((a) => a.name === 'Duplicates and redirects').found, 1);
  });
  test('progress counts finished areas, and is null when nothing was started from the page', () => {
    const areas = [{ state: 'done' }, { state: 'running' }, { state: 'waiting' }];
    assert.deepEqual(runProgress(areas, new Set(['a'])), { done: 1, n: 3 });
    assert.equal(runProgress(areas, new Set()), null);
  });
});
