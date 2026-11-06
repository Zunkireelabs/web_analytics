import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getProjectMemory, snapshotProjectMemory, freshnessOf, contentHash, digestOf, MEMORY_SECTIONS } from './project-memory.js';

// No database: every reader is injected, and `calls` records which siteId each one was asked about, so isolation is
// proven by what was queried, not only by what came back.

const NOW = new Date('2026-11-04T00:00:00Z');

function makeWorld() {
  const base = (id, workspaceId, marker, rival) => ({
    site: {
      id, workspace_id: workspaceId, repo_name: `org/site-${id}`,
      url_file_map: { siteRoot: {
        designProfile: { version: 3, derivedAt: '2026-10-30T00:00:00Z', typography: { huge: 'x'.repeat(5000) }, color: { brand: '#123456' } },
        componentTemplates: { faq: {} },
      } },
    },
    ctx: {
      propertyType: 'website', industries: [`industry-${marker}`], markets: ['NP'],
      goals: [{ id: id * 10, objective: `PRIVATE-GOAL-${marker}`, goalType: 'leads', primaryMetric: 'clicks' }],
      siteProfile: { site_type: 'service', profiled_at: '2026-10-01T00:00:00Z' }, seoPolicy: null,
    },
    understanding: [{ category: 'technology', total: 3, ready: 2, unresolved: 1, avgConfidence: 0.9 }],
    tech: [{ subject: 'framework', status: 'confirmed', confidence: '0.95', finding: { id: 'nextjs' }, updated_at: '2026-10-20T00:00:00Z' }],
    baseline: { generated_at: '2026-10-02T00:00:00Z', kpi_snapshot: { clicks: 10 } },
    competitors: [{ domain: rival, last_analyzed_at: '2026-10-25T00:00:00Z' }],
    geo: 41,
    keywordGaps: [{ status: 'pending_review', n: 4, latest: '2026-10-25T00:00:00Z' }],
    lifecycle: { total: 5, implemented: 2, abandoned: 0, nonImplemented: 3, submittedForApproval: 1, implementedThisWeek: 1 },
    deployments: [{ id: id * 100, status: 'deployed', pr_number: 12, merged_at: '2026-10-28T00:00:00Z', deployed_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z' }],
    impact: [{ generator_id: 'faq', measured: 2 }],
    behaviour: {
      lifecycle: { total: 5, merged: 2, deploymentVerified: 1 },
      generators: [{ generatorId: 'faq', technicalEvidence: 'limited', impactEvidence: 'insufficient', demoted: false, text: `faq: 4 of 5 recent attempts shipped or merged (80%) [${marker}]`, counts: { shipped: 4 } }],
    },
  });
  return {
    1: base(1, 10, 'ALPHA', 'rival-a.example'),
    2: base(2, 10, 'BETA', 'rival-b.example'),
    3: base(3, 20, 'GAMMA', 'rival-c.example'),
  };
}

function fakeDeps(world, calls = []) {
  const track = (name, fn) => async (siteId, ...rest) => { calls.push([name, siteId]); return fn(world[siteId], ...rest); };
  return {
    getSiteById: track('getSiteById', (w) => w?.site ?? null),
    loadTenantContext: track('loadTenantContext', (w) => w?.ctx ?? null),
    summarizeUnderstanding: track('summarizeUnderstanding', (w) => w?.understanding ?? []),
    listFindings: track('listFindings', (w) => w?.tech ?? []),
    getBaselineReport: track('getBaselineReport', (w) => w?.baseline ?? null),
    listCompetitorProfiles: track('listCompetitorProfiles', (w) => w?.competitors ?? []),
    getLatestGeoAuditScore: track('getLatestGeoAuditScore', (w) => w?.geo ?? null),
    keywordGapSummary: track('keywordGapSummary', (w) => w?.keywordGaps ?? []),
    countDraftsByLifecycle: track('countDraftsByLifecycle', (w) => w?.lifecycle ?? { total: 0 }),
    listDeploymentsForSite: track('listDeploymentsForSite', (w) => w?.deployments ?? []),
    impactByGenerator: track('impactByGenerator', (w) => w?.impact ?? []),
    getBehaviourLearning: track('getBehaviourLearning', (w) => w?.behaviour ?? { generators: [], lifecycle: { total: 0 } }),
    isProfileUsable: async (p) => Boolean(p?.typography),
    profileCaptureGaps: async (p) => (p?.navigation ? [] : ['navigation']),
  };
}

// An in-memory stand-in for project_memory_log, with the same "latest version per (site, section)" behaviour.
function fakeLog() {
  const rows = [];
  return {
    rows,
    getLatestMemoryVersion: async (siteId, section) => rows.filter((r) => r.siteId === siteId && r.section === section).sort((a, b) => b.version - a.version)[0]
      ? (({ version, content_hash }) => ({ version, content_hash }))(rows.filter((r) => r.siteId === siteId && r.section === section).sort((a, b) => b.version - a.version)[0])
      : null,
    insertMemoryVersion: async (siteId, section, { contentHash, digest, provenance, reason }) => {
      const version = rows.filter((r) => r.siteId === siteId && r.section === section).length + 1;
      rows.push({ siteId, section, version, content_hash: contentHash, digest, provenance, reason });
      return { version };
    },
  };
}

describe('getProjectMemory: isolation', () => {
  test('two projects in one workspace get separate memories, and only their own rows are queried', async () => {
    const world = makeWorld();
    const calls = [];
    const deps = fakeDeps(world, calls);

    const a = await getProjectMemory(1, { deps, now: NOW });
    const callsForA = calls.splice(0);
    const b = await getProjectMemory(2, { deps, now: NOW });
    const callsForB = calls.splice(0);

    assert.equal(a.workspaceId, 10);
    assert.equal(b.workspaceId, 10);
    assert.deepEqual(a.sections.business.data.industries, ['industry-ALPHA']);
    assert.deepEqual(b.sections.business.data.industries, ['industry-BETA']);
    assert.deepEqual(a.sections.search.data.competitorDomains, ['rival-a.example']);
    assert.deepEqual(b.sections.search.data.competitorDomains, ['rival-b.example']);

    // Nothing of project 1 anywhere in project 2's memory, and the reverse.
    assert.ok(!JSON.stringify(b).includes('ALPHA') && !JSON.stringify(b).includes('rival-a'));
    assert.ok(!JSON.stringify(a).includes('BETA') && !JSON.stringify(a).includes('rival-b'));

    // Every reader was only ever asked about the project that was requested.
    assert.ok(callsForA.length > 5 && callsForA.every(([, id]) => id === 1), JSON.stringify(callsForA));
    assert.ok(callsForB.length > 5 && callsForB.every(([, id]) => id === 2), JSON.stringify(callsForB));
  });

  test("a project in another workspace is refused before any section is read", async () => {
    const world = makeWorld();
    const calls = [];
    await assert.rejects(
      () => getProjectMemory(3, { expectWorkspaceId: 10, deps: fakeDeps(world, calls), now: NOW }),
      (err) => err.code === 'PROJECT_NOT_IN_WORKSPACE' && err.status === 404 && err.userFacing === true && err.message === 'Project not found',
    );
    assert.deepEqual(calls, [['getSiteById', 3]], 'only the ownership lookup may run');
  });

  test('the matching workspace is allowed; no workspace given means no guard (trusted caller)', async () => {
    const world = makeWorld();
    const ok = await getProjectMemory(1, { expectWorkspaceId: 10, deps: fakeDeps(world), now: NOW });
    assert.equal(ok.siteId, 1);
    const unguarded = await getProjectMemory(3, { deps: fakeDeps(world), now: NOW });
    assert.equal(unguarded.siteId, 3);
  });

  test('an unknown project is null, not an error', async () => {
    assert.equal(await getProjectMemory(999, { deps: fakeDeps(makeWorld()), now: NOW }), null);
  });
});

describe('getProjectMemory: missing and failing data', () => {
  test('a brand-new project has every section empty and nothing throws', async () => {
    const world = { 5: { site: { id: 5, workspace_id: 10, url_file_map: null }, ctx: { propertyType: 'website', industries: [], markets: [], goals: [], siteProfile: null, seoPolicy: null } } };
    const m = await getProjectMemory(5, { deps: fakeDeps(world), now: NOW });
    for (const s of MEMORY_SECTIONS) {
      assert.equal(m.sections[s].status, 'empty', `${s} should be empty`);
      assert.equal(m.sections[s].data, null);
      assert.equal(m.sections[s].provenance.freshness, 'unknown');
    }
  });

  test('one unavailable source marks only its own section as error', async () => {
    const world = makeWorld();
    const deps = { ...fakeDeps(world), listCompetitorProfiles: async () => { throw new Error('connection terminated'); } };
    const m = await getProjectMemory(1, { deps, now: NOW });
    assert.equal(m.sections.search.status, 'error');
    assert.match(m.sections.search.reason, /connection terminated/);
    for (const s of ['business', 'technical', 'design', 'history']) assert.equal(m.sections[s].status, 'ok', `${s} must be unaffected`);
  });

  test('asking for some sections reads only those', async () => {
    const calls = [];
    const m = await getProjectMemory(1, { sections: ['design'], deps: fakeDeps(makeWorld(), calls), now: NOW });
    assert.deepEqual(Object.keys(m.sections), ['design']);
    assert.ok(!calls.some(([name]) => ['getBaselineReport', 'listCompetitorProfiles', 'countDraftsByLifecycle'].includes(name)));
  });
});

describe('getProjectMemory: section content', () => {
  test('design is a summary: it says whether the profile is usable but never carries the profile', async () => {
    const m = await getProjectMemory(1, { deps: fakeDeps(makeWorld()), now: NOW });
    const d = m.sections.design;
    assert.equal(d.status, 'ok');
    assert.deepEqual(Object.keys(d.data).sort(), ['captureGaps', 'componentTemplates', 'derivedAt', 'profilePresent', 'profileVersion', 'usable']);
    assert.equal(d.data.usable, true);
    assert.deepEqual(d.data.captureGaps, ['navigation']);
    assert.deepEqual(d.data.componentTemplates, ['faq']);
    assert.ok(JSON.stringify(d).length < 1000, 'the 5 KB typography block must not be copied into memory');
    assert.ok(!JSON.stringify(d).includes('#123456'));
  });

  test('a site with templates but no profile is reported as present-but-unusable, not hidden', async () => {
    const world = makeWorld();
    world[1].site.url_file_map = { siteRoot: { componentTemplates: { faq: {} } } };
    const m = await getProjectMemory(1, { deps: fakeDeps(world), now: NOW });
    assert.equal(m.sections.design.data.profilePresent, false);
    assert.equal(m.sections.design.data.usable, false);
  });

  test('search reads the real column names: the baseline date and the newest competitor analysis set the section date', async () => {
    const m = await getProjectMemory(1, { deps: fakeDeps(makeWorld()), now: NOW });
    const s = m.sections.search;
    assert.equal(s.data.baselineCapturedAt, '2026-10-02T00:00:00Z');
    assert.deepEqual(s.data.baselineKpis, { clicks: 10 });
    assert.equal(s.provenance.asOf, '2026-10-25T00:00:00.000Z'); // newest of baseline / competitors / keyword backlog
    assert.equal(s.provenance.freshness, 'fresh'); // 10 days old, inside the 14-day window
  });

  test('history keeps the lifecycle stages apart and makes no causal claim', async () => {
    const m = await getProjectMemory(1, { deps: fakeDeps(makeWorld()), now: NOW });
    const h = m.sections.history.data;
    assert.equal(h.recentDeployments[0].status, 'deployed');
    assert.equal(h.recentDeployments[0].prNumber, 12);
    assert.ok(h.recentDeployments[0].mergedAt && h.recentDeployments[0].deployedAt);
    assert.deepEqual(Object.keys(h).sort(), ['behaviour', 'drafts', 'measuredImpactByGenerator', 'recentDeployments']);
  });

  test('history carries what was learned on this project, with its evidence label, and only on this project', async () => {
    const world = makeWorld();
    const a = (await getProjectMemory(1, { deps: fakeDeps(world), now: NOW })).sections.history.data.behaviour;
    const b = (await getProjectMemory(2, { deps: fakeDeps(world), now: NOW })).sections.history.data.behaviour;
    assert.equal(a.generators[0].generatorId, 'faq');
    assert.equal(a.generators[0].technicalEvidence, 'limited');
    assert.match(a.generators[0].text, /\[ALPHA\]/);
    assert.match(b.generators[0].text, /\[BETA\]/);
    assert.ok(!JSON.stringify(a).includes('BETA') && !JSON.stringify(b).includes('ALPHA'));
    assert.equal(a.generators[0].counts, undefined, 'raw counts stay in the learning module; memory keeps the readable summary');
    assert.deepEqual(a.lifecycle, { total: 5, merged: 2, deploymentVerified: 1 });
  });

  test('if behaviour learning is unavailable the rest of the history still loads', async () => {
    const deps = { ...fakeDeps(makeWorld()), getBehaviourLearning: async () => { throw new Error('learning tables unavailable'); } };
    const m = await getProjectMemory(1, { deps, now: NOW });
    assert.equal(m.sections.history.status, 'ok');
    assert.equal(m.sections.history.data.behaviour, null);
    assert.equal(m.sections.history.data.recentDeployments.length, 1);
  });

  test('every ok section carries its sources and a freshness verdict', async () => {
    const m = await getProjectMemory(1, { deps: fakeDeps(makeWorld()), now: NOW });
    for (const s of MEMORY_SECTIONS) {
      assert.ok(m.sections[s].provenance.sources.length > 0, `${s} sources`);
      assert.ok(['fresh', 'aging', 'stale', 'unknown'].includes(m.sections[s].provenance.freshness));
    }
    assert.equal(m.sections.design.provenance.freshness, 'fresh'); // derived 5 days before NOW
    assert.equal(m.sections.history.provenance.freshness, 'aging'); // last deployment 6 days before NOW, past the 2-day window
  });
});

describe('freshnessOf', () => {
  const days = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
  test('uses a different window per section', () => {
    assert.equal(freshnessOf('design', days(10), NOW), 'fresh');
    assert.equal(freshnessOf('design', days(60), NOW), 'aging');
    assert.equal(freshnessOf('design', days(200), NOW), 'stale');
    assert.equal(freshnessOf('history', days(1), NOW), 'fresh');
    assert.equal(freshnessOf('history', days(20), NOW), 'stale');
  });
  test('no date, a bad date or an unknown section is unknown, never fresh', () => {
    assert.equal(freshnessOf('design', null, NOW), 'unknown');
    assert.equal(freshnessOf('design', 'not a date', NOW), 'unknown');
    assert.equal(freshnessOf('nope', days(1), NOW), 'unknown');
  });
});

describe('contentHash and digestOf', () => {
  test('the same content hashes the same whatever the key order', () => {
    assert.equal(contentHash({ a: 1, b: { c: [1, 2], d: null } }), contentHash({ b: { d: null, c: [1, 2] }, a: 1 }));
  });
  test('any change in content changes the hash', () => {
    assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
    assert.notEqual(contentHash({ a: [1, 2] }), contentHash({ a: [2, 1] }));
  });
  test('digest keeps scalars and sizes, never the content', () => {
    const d = digestOf({ usable: true, version: 3, name: 'x'.repeat(500), items: [1, 2, 3], nested: { a: 1, b: 2 }, gone: undefined });
    assert.deepEqual(d, { usable: true, version: 3, name: 'x'.repeat(120), itemsCount: 3, nestedKeys: 2 });
  });
});

describe('snapshotProjectMemory: versioning', () => {
  test('first snapshot records every ok section as version 1; an identical second one records nothing', async () => {
    const world = makeWorld();
    const log = fakeLog();
    const deps = { ...fakeDeps(world), ...log };

    const first = await snapshotProjectMemory(1, { reason: 'onboarding', deps, now: NOW });
    assert.deepEqual(first.changed.map((c) => `${c.section}:${c.version}`).sort(), MEMORY_SECTIONS.map((s) => `${s}:1`).sort());
    assert.ok(log.rows.every((r) => r.reason === 'onboarding' && r.siteId === 1));

    const later = new Date('2026-11-09T00:00:00Z'); // only the clock moved: freshness changes, content does not
    const second = await snapshotProjectMemory(1, { deps, now: later });
    assert.deepEqual(second.changed, []);
    assert.equal(second.unchanged.length, MEMORY_SECTIONS.length);
    assert.equal(log.rows.length, MEMORY_SECTIONS.length, 'no new rows for an unchanged project');
  });

  test('a real change adds a new version for that section only', async () => {
    const world = makeWorld();
    const log = fakeLog();
    const deps = { ...fakeDeps(world), ...log };
    await snapshotProjectMemory(1, { deps, now: NOW });

    world[1].ctx.goals.push({ id: 99, objective: 'Win more enquiries', goalType: 'leads', primaryMetric: 'conversions' });
    const r = await snapshotProjectMemory(1, { deps, now: NOW });
    assert.deepEqual(r.changed, [{ section: 'business', version: 2 }]);
    assert.equal(log.rows.filter((x) => x.section === 'business').length, 2);
    assert.equal(log.rows.filter((x) => x.section === 'design').length, 1);
  });

  test('a failed read is never recorded as a change', async () => {
    const world = makeWorld();
    const log = fakeLog();
    const okDeps = { ...fakeDeps(world), ...log };
    await snapshotProjectMemory(1, { deps: okDeps, now: NOW });

    const failing = { ...okDeps, listCompetitorProfiles: async () => { throw new Error('timeout'); } };
    const r = await snapshotProjectMemory(1, { deps: failing, now: NOW });
    assert.deepEqual(r.changed, []);
    assert.deepEqual(r.skipped, [{ section: 'search', status: 'error' }]);
    assert.equal(log.rows.filter((x) => x.section === 'search').length, 1, 'the outage must not become version 2');
  });

  test('a new project with nothing yet writes nothing and does not fail', async () => {
    const world = { 5: { site: { id: 5, workspace_id: 10, url_file_map: null }, ctx: { propertyType: 'website', industries: [], markets: [], goals: [], siteProfile: null, seoPolicy: null } } };
    const log = fakeLog();
    const r = await snapshotProjectMemory(5, { reason: 'onboarding', deps: { ...fakeDeps(world), ...log }, now: NOW });
    assert.equal(r.found, true);
    assert.deepEqual(r.changed, []);
    assert.equal(log.rows.length, 0);
    assert.equal(r.skipped.length, MEMORY_SECTIONS.length);
  });

  test('losing a write race counts as unchanged, not as an error', async () => {
    const world = makeWorld();
    const deps = { ...fakeDeps(world), getLatestMemoryVersion: async () => null, insertMemoryVersion: async () => null };
    const r = await snapshotProjectMemory(1, { deps, now: NOW });
    assert.deepEqual(r.changed, []);
    assert.equal(r.unchanged.length, MEMORY_SECTIONS.length);
  });

  test('an unknown project reports found:false', async () => {
    const r = await snapshotProjectMemory(999, { deps: { ...fakeDeps(makeWorld()), ...fakeLog() }, now: NOW });
    assert.deepEqual(r, { siteId: 999, found: false, changed: [], unchanged: [], skipped: [] });
  });

  test("project 1's snapshot never writes under another project's id", async () => {
    const world = makeWorld();
    const log = fakeLog();
    await snapshotProjectMemory(1, { deps: { ...fakeDeps(world), ...log }, now: NOW });
    await snapshotProjectMemory(2, { deps: { ...fakeDeps(world), ...log }, now: NOW });
    assert.deepEqual([...new Set(log.rows.map((r) => r.siteId))].sort(), [1, 2]);
    assert.ok(log.rows.filter((r) => r.siteId === 1).every((r) => !JSON.stringify(r).includes('BETA')));
    assert.ok(log.rows.filter((r) => r.siteId === 2).every((r) => !JSON.stringify(r).includes('ALPHA')));
  });
});
