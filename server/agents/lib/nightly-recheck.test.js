import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideRecheck, planRechecks, recheckOpenIssuesForSite, closeSatisfiedIdeasForSite, closeUnreportedOpportunities } from './nightly-recheck.js';

const keyOf = (f) => f.recommendedAction.params.page;
const rec = (id, page, over = {}) => ({ id, page, recommendation_type: 'meta-title', detecting_agents: ['seo'], params: {}, last_rechecked_at: null, ...over });
const finding = (page, type = 'meta-title') => ({ recommendedAction: { generatorId: type, params: { page } } });

describe('what a re-check means', () => {
  test('the agent still reports it: still present', () => assert.equal(decideRecheck(rec(1, '/a'), { facts: { findings: [finding('/a')] } }, keyOf), 'still-present'));
  test('page re-read, not reported: fixed', () => assert.equal(decideRecheck(rec(1, '/a'), { facts: { findings: [], checkedPages: ['https://x.test/a/'] } }, keyOf), 'fixed'));
  test('agent that does not list pages and reports nothing: fixed (as the manual re-check always did)', () => assert.equal(decideRecheck(rec(1, '/a'), { facts: { findings: [] } }, keyOf), 'fixed'));
  test('page not among those it checked (unreachable, skipped): never taken as fixed', () => assert.equal(decideRecheck(rec(1, '/a'), { facts: { findings: [], checkedPages: ['/other'] } }, keyOf), 'unverified'));
  test('no usable answer: unverified', () => assert.equal(decideRecheck(rec(1, '/a'), { facts: {} }, keyOf), 'unverified'));
});

describe('planning the night', () => {
  test('oldest-checked first, so the 11th issue is not starved by the first 10', () => {
    const rows = [rec(1, '/a', { last_rechecked_at: '2026-11-18T00:00:00Z' }), rec(2, '/b'), rec(3, '/c', { last_rechecked_at: '2026-11-10T00:00:00Z' })];
    assert.deepEqual(planRechecks(rows).groups[0].recs.map((r) => r.id), [2, 3, 1]);
  });
  test('cap per project; groups of at most 20 pages per agent; links and agent-less rows handled apart', () => {
    const rows = Array.from({ length: 45 }, (_, i) => rec(i + 1, `/p${i}`));
    rows.push(rec(100, '/x', { recommendation_type: 'broken-link-fix', params: { href: 'h' } }), rec(101, '/y', { detecting_agents: [] }));
    const p = planRechecks(rows, { limit: 100 });
    assert.deepEqual(p.groups.map((g) => g.recs.length), [20, 20, 5]);
    assert.equal(p.links.length, 1);
    assert.equal(planRechecks(rows, { limit: 10 }).groups.reduce((n, g) => n + g.recs.length, 0) <= 10, true);
  });
});

describe('one project, end to end with stand-ins', () => {
  test('closes the fixed, keeps the still-broken, leaves unverified alone, stamps what it checked', async () => {
    const rows = [rec(1, '/fixed'), rec(2, '/broken'), rec(3, '/unreachable'), rec(4, '/link', { recommendation_type: 'broken-link-fix', params: { href: 'https://x.test/dead' } })];
    const closed = []; const stamped = [];
    const out = await recheckOpenIssuesForSite(9, { deps: {
      query: async (sql, args) => { if (/^\s*SELECT/i.test(sql)) return { rows }; if (/UPDATE/i.test(sql)) stamped.push(...args[1]); return { rows: [] }; },
      getSiteById: async () => ({ timezone: 'UTC' }),
      coord: { recommendationPageKey: ({ params }) => params.page },
      runAgent: async () => ({ facts: { findings: [finding('/broken')], checkedPages: ['/fixed', '/broken'] } }),
      recheckLink: async () => ({ broken: false }),
      close: async (id) => { closed.push(id); },
    } });
    assert.deepEqual(closed.sort(), [1, 4]);
    assert.deepEqual([out.fixed, out.stillOpen, out.unverified], [2, 1, 1]);
    assert.ok(stamped.includes(2) && stamped.includes(4) && !stamped.includes(3));
  });
  test('an agent that fails leaves its issues exactly as they are', async () => {
    const closed = [];
    const out = await recheckOpenIssuesForSite(9, { deps: {
      query: async (sql) => (/^\s*SELECT/i.test(sql) ? { rows: [rec(1, '/a')] } : { rows: [] }),
      getSiteById: async () => ({}), coord: { recommendationPageKey: () => '' },
      runAgent: async () => { throw new Error('Unknown agent seo'); }, recheckLink: async () => ({}), close: async (id) => closed.push(id),
    } });
    assert.deepEqual(closed, []); assert.equal(out.errors, 1);
  });
});

describe('site-wide issues', () => {
  test('a site-wide issue is checked by running its agent over the whole site once', () => {
    const rows = [rec(1, '', { detecting_agents: ['trust-compliance'], recommendation_type: 'privacy-policy' }), rec(2, '', { detecting_agents: ['trust-compliance'], recommendation_type: 'cookie-policy' })];
    const p = planRechecks(rows);
    assert.equal(p.groups.length, 1);
    assert.equal(p.groups[0].siteWide, true);
    assert.equal(p.groups[0].recs.length, 2);
  });
  test('fixed when the agent no longer reports it; a page list does not apply to it', () => {
    const r = rec(1, '', { recommendation_type: 'privacy-policy' });
    assert.equal(decideRecheck(r, { facts: { findings: [], checkedPages: ['/x'] } }, keyOf), 'fixed');
    assert.equal(decideRecheck(r, { facts: { findings: [finding('', 'privacy-policy')] } }, keyOf), 'still-present');
  });
});

describe('ideas that the site now covers', () => {
  const row = (id, topic, extra = {}) => ({ id, params: { topic, ...extra } });
  test('closes a blog idea whose topic a page now covers; keeps the rest and stamps them', async () => {
    const closed = []; const stamped = [];
    const out = await closeSatisfiedIdeasForSite(1, { deps: {
      query: async (sql, a) => { if (/^\s*SELECT/i.test(sql)) return { rows: [row(1, 'seo audit'), row(2, 'new idea'), row(3, 'unsure')] }; stamped.push(a[0]); return { rows: [] }; },
      classify: async (_s, g) => ({ 'seo audit': { status: 'covered', url: '/blog/seo-audit' }, 'new idea': { status: 'opportunity', url: null }, unsure: { status: 'uncertain' } })[g.topic],
      close: async (id) => closed.push(id),
    } });
    assert.deepEqual(closed, [1]); assert.deepEqual(stamped.sort(), [2, 3]); assert.equal(out.closed, 1);
  });
  test('a covered verdict with no page is not trusted', async () => {
    const closed = [];
    await closeSatisfiedIdeasForSite(1, { deps: { query: async (sql) => (/^\s*SELECT/i.test(sql) ? { rows: [row(1, 'x')] } : { rows: [] }), classify: async () => ({ status: 'covered', url: null }), close: async (id) => closed.push(id) } });
    assert.deepEqual(closed, []);
  });
});

describe('growth opportunities the detector no longer reports', () => {
  const rows = [{ id: 1, page: '/a', recommendation_type: 'meta-title' }, { id: 2, page: '/b', recommendation_type: 'meta-title' }];
  test('closes those missing from today\'s report, keeps those still reported', async () => {
    const closed = [];
    const out = await closeUnreportedOpportunities(1, new Set(['meta-title::/a']), { deps: { query: async (sql) => (/GREATEST/.test(sql) ? { rows: [{ ok: true }] } : { rows }), close: async (id) => closed.push(id) } });
    assert.deepEqual(closed, [2]); assert.equal(out.closed, 1);
  });
  test('with no fresh Search Console data nothing is closed (an outage must not empty the list)', async () => {
    const closed = [];
    const out = await closeUnreportedOpportunities(1, new Set(), { deps: { query: async (sql) => (/GREATEST/.test(sql) ? { rows: [{ ok: false }] } : { rows }), close: async (id) => closed.push(id) } });
    assert.deepEqual(closed, []); assert.equal(out.closed, 0);
  });
});
