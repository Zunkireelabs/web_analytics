// SIX CLIENTS, INDEPENDENTLY, on a real Postgres (the LOCAL throwaway srtest; skipped unless DATABASE_URL points there). Six temporary projects with the
// situations the real six are in on 2026-11-25: Admizz (posts at the site root, found by signals not URLs), Chayce (10 abandoned drafts whose content stays),
// Zennly, Zunkiree (a post in an open PR), SuperRank, and MOBILISE (review-first: 8 drafts awaiting review). Proves the content index, the evidence gate, the
// decision log and continuous research each keep every client's data apart, that one client failing never touches the others, and the Phase 5-7
// acceptance points: existing blogs are excluded from duplicate generation, a failed article leaves its siblings, an empty backlog starts research.
//   DB_SSL=off DATABASE_URL=postgres://postgres:<local password>@localhost:55432/srtest node --experimental-test-module-mocks --test server/lib/blog-cycle/six-clients.db.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = /@(localhost|127\.0\.0\.1):55432\//.test(process.env.DATABASE_URL || '');
const CLIENTS = [
  { key: 'admizz', name: 'Admizz (six-clients test)', domain: 'admizz.test', ship_mode: 'auto' },
  { key: 'chayce', name: 'Chayce (six-clients test)', domain: 'chayce.test', ship_mode: 'auto' },
  { key: 'zennly', name: 'Zennly (six-clients test)', domain: 'zennly.test', ship_mode: 'auto' },
  { key: 'zunkiree', name: 'Zunkiree (six-clients test)', domain: 'zunkiree.test', ship_mode: 'auto' },
  { key: 'superrank', name: 'SuperRank (six-clients test)', domain: 'superrank.test', ship_mode: 'auto' },
  { key: 'mobilise', name: 'MOBILISE (six-clients test)', domain: 'mobilise.test', ship_mode: 'review-first' },
];

describe('the content index, evidence gate, decision log and research across six clients', { skip: !LOCAL }, () => {
  let db; let store; let select; let research; let log; let pipeline;
  const site = {}; // key -> { id, ... }
  const cleanup = async () => {
    const ids = Object.values(site).map((s) => s.id).filter(Boolean);
    if (!ids.length) return;
    for (const t of ['topic_decisions', 'content_index', 'drafts', 'recommendations', 'page_inventory', 'seo_page_snapshots', 'page_content_classification', 'gsc_query_page', 'keyword_gaps']) await db.query(`DELETE FROM ${t} WHERE site_id = ANY($1::int[])`, [ids]);
    await db.query(`DELETE FROM sites WHERE id = ANY($1::int[])`, [ids]);
  };
  before(async () => {
    db = await import('../../db.js'); store = await import('../content-index/store.js'); select = await import('./select.js'); research = await import('../topic-research/research.js');
    log = await import('../topic-research/decision-log.js'); pipeline = await import('./pipeline.js');
    await db.query(`DELETE FROM sites WHERE name LIKE '%(six-clients test)'`);
    for (const c of CLIENTS) {
      const { rows } = await db.query(`INSERT INTO sites (name, website_domain, ship_mode, timezone) VALUES ($1, $2, $3, 'Asia/Kolkata') RETURNING id`, [c.name, c.domain, c.ship_mode]);
      site[c.key] = { id: rows[0].id, timezone: 'Asia/Kolkata', name: c.name, website_domain: c.domain, ship_mode: c.ship_mode };
    }
    const S = (k) => site[k].id;
    const inv = (k, page) => db.query(`INSERT INTO page_inventory (site_id, page, discovered_via) VALUES ($1, $2, 'six-clients-test')`, [S(k), page]);
    const snap = (k, url, title, schema) => db.query(`INSERT INTO seo_page_snapshots (site_id, url, title, schema_types) VALUES ($1, $2, $3, $4::jsonb)`, [S(k), url, title, JSON.stringify(schema)]);
    const draft = (k, status, topic, extra = {}) => db.query(`INSERT INTO drafts (site_id, action_type, source, input, content, status, pr_state, pr_url, branch_name, target_file_path) VALUES ($1, 'blog-outline', 'six-clients-test', '{}', $2::jsonb, $3, $4, $5, $6, $7)`,
      [S(k), JSON.stringify({ topic, title: topic }), status, extra.pr_state || null, extra.pr_url || null, extra.branch || null, extra.file || null]);
    // Admizz: posts at the SITE ROOT. No /blog/ anywhere.
    for (const [slug, title] of [['uk-student-visa-success-rate-nepali-students-2027', 'UK Student Visa Success Rate for Nepal (2027)'], ['minimum-ielts-requirement-for-canadian-universities', 'Minimum IELTS Score for Canadian Universities'], ['best-courses-for-studying-abroad-in-2026', 'Best courses for studying abroad in 2026']]) {
      await inv('admizz', `https://admizz.test/${slug}`); await snap('admizz', `https://admizz.test/${slug}`, title, ['BlogPosting']);
    }
    await inv('admizz', 'https://admizz.test/contact'); await snap('admizz', 'https://admizz.test/contact', 'Contact', ['WebSite']);
    // Chayce: ten abandoned drafts (content stays in the rows, but they block nothing) and one published post under /blog/
    for (let i = 0; i < 10; i++) await draft('chayce', 'abandoned', `moving checklist topic ${i}`);
    await inv('chayce', 'https://chayce.test/blog/uk-house-moving-checklist'); await snap('chayce', 'https://chayce.test/blog/uk-house-moving-checklist', 'UK house moving checklist', ['Article']);
    // Zunkiree: a post currently in an OPEN pull request
    await draft('zunkiree', 'pr_opened', 'vercel agent desktop computer use explained', { pr_state: 'open', pr_url: 'https://github.com/Zunkireelabs/zunkireelabs-web/pull/91', branch: 'action-center/batch-x', file: 'src/blog/vercel-agent.md' });
    // MOBILISE: eight drafts awaiting review (review-first)
    for (let i = 0; i < 8; i++) await draft('mobilise', 'submitted_for_approval', `recruitment process guide ${i}`);
    // Zennly and SuperRank: nothing special (SuperRank has one merged post)
    await draft('superrank', 'implemented', 'how to track google ai overviews');
    await store.refreshContentIndex(S('admizz')); // warm one; the rest are built by the tests
  });
  after(async () => { await cleanup(); await db.pool?.end?.(); });

  test('each client\'s index holds only its own content; Admizz\'s root-level posts are found by signals, not URLs', async () => {
    const results = {};
    for (const c of CLIENTS) results[c.key] = await store.refreshContentIndex(site[c.key].id);
    const entries = Object.fromEntries(await Promise.all(CLIENTS.map(async (c) => [c.key, await store.loadContentIndex(site[c.key].id)])));
    assert.equal(entries.admizz.filter((e) => e.kind === 'blog' && e.state === 'published').length, 3, 'three posts found, none under /blog/');
    assert.equal(entries.admizz.find((e) => e.url.endsWith('/contact')).kind, 'page');
    assert.equal(entries.chayce.filter((e) => e.state === 'draft' || e.state === 'approved').length, 0, 'abandoned drafts block nothing');
    assert.equal(entries.zunkiree.find((e) => e.draftId != null).state, 'in_pr');
    assert.equal(entries.mobilise.filter((e) => e.state === 'draft').length, 8);
    assert.equal(entries.superrank.find((e) => e.draftId != null).state, 'merged');
    assert.equal(entries.zennly.length, 0, 'a client with no content has an empty index (and is still processed)');
    const urls = (k) => entries[k].map((e) => e.url).filter(Boolean);
    assert.ok(!urls('chayce').some((u) => u.includes('admizz.test')) && !urls('admizz').some((u) => u.includes('chayce.test')), 'no content crosses clients');
    assert.equal(results.admizz.total, 4);
  });

  test('a topic one client already has is a duplicate there and NOT for the others', async () => {
    const check = await import('../content-index/check.js');
    const entries = Object.fromEntries(await Promise.all(CLIENTS.map(async (c) => [c.key, await store.loadContentIndex(site[c.key].id)])));
    const topic = 'uk student visa success rate nepal';
    assert.equal(check.checkTopicAgainstIndex({ topic, entries: entries.admizz }).ok, false);
    for (const k of ['chayce', 'zennly', 'zunkiree', 'superrank', 'mobilise']) assert.equal(check.checkTopicAgainstIndex({ topic, entries: entries[k] }).ok, true, k);
    assert.equal(check.checkTopicAgainstIndex({ topic: 'vercel agent desktop computer use explained', entries: entries.zunkiree }).matches[0].state, 'in_pr');
    assert.equal(check.checkTopicAgainstIndex({ topic: 'vercel agent desktop computer use explained', entries: entries.admizz }).ok, true);
  });

  test('the evidence gate runs per client against its own index and writes each client\'s own decisions; existing blogs are excluded from duplicate generation', async () => {
    const accept = (a = ['visa']) => ({ verdict: 'accept', reasons: ['relevant'], anchors: a, criteria: { matchesAudience: true } });
    const rec = (id, topic) => ({ id, recommendation_type: 'blog-outline', params: { topic }, detecting_agents: ['content-gap'] });
    const deps = (siteId) => ({
      // the REAL index and the REAL decision log; only the model and the Search Console lookups are stood in
      judge: async (_s, ts) => new Map(ts.map((t) => [t, /crypto/.test(t) ? { verdict: 'reject', reasons: ['not about what the company sells'], anchors: [] } : accept()])),
      gather: async () => ({ gsc: { relatedQueries: [{ query: 'q', impressions: 20 }], rankingPages: [] }, demand: { searchVolume: 25 }, coverage: { status: 'opportunity' }, signals: { detectors: ['content-gap'] } }),
      recentRelevance: async () => new Map(),
    });
    const out = {};
    for (const [key, topics] of Object.entries({
      admizz: ['uk student visa success rate nepal', 'ielts band requirements for australia', 'best crypto exchanges'],
      zunkiree: ['vercel agent desktop computer use explained', 'ai agents for small business automation'],
      chayce: ['uk house moving checklist', 'removals cost for elderly moves'],
    })) {
      out[key] = await select.applyBlogEvidenceGate(site[key], topics.map((t, i) => rec(100 + i, t)), { mode: 'enforce', deps: deps(site[key].id) });
    }
    assert.deepEqual(out.admizz.kept.map((r) => r.params.topic), ['ielts band requirements for australia'], 'the published post and the off-business topic are excluded');
    assert.deepEqual(out.zunkiree.kept.map((r) => r.params.topic), ['ai agents for small business automation'], 'the topic already in an open PR is excluded');
    assert.deepEqual(out.chayce.kept.map((r) => r.params.topic), ['removals cost for elderly moves'], 'the already-published post is excluded');
    const rows = (k) => log.listTopicDecisions(site[k].id, { origin: 'gate', limit: 50 });
    const [a, z, c] = await Promise.all([rows('admizz'), rows('zunkiree'), rows('chayce')]);
    assert.equal(a.length, 3); assert.equal(z.length, 2); assert.equal(c.length, 2);
    assert.match(a.find((r) => r.topic === 'uk student visa success rate nepal').gates.find((g) => !g.ok).detail, /already published/);
    assert.match(z.find((r) => r.topic.startsWith('vercel')).gates.find((g) => !g.ok).detail, /open pull request/);
    assert.match(a.find((r) => r.topic === 'best crypto exchanges').gates.find((g) => !g.ok).detail, /not about what the company sells/);
    assert.ok((await rows('superrank')).length === 0 && (await rows('mobilise')).length === 0, 'clients not touched have no decisions');
  });

  test('continuous research across all six clients: each is judged against its OWN index and data; one that fails does not stop the others; the empty-backlog ones start research', async () => {
    const S = (k) => site[k].id;
    const accept = () => ({ verdict: 'accept', reasons: ['relevant'], anchors: ['visa'], criteria: { matchesAudience: true } });
    // seed an open keyword gap for every client; Admizz's is one it already published (must NOT be proposed), the rest are new to them
    const gap = (k, topic) => db.query(`INSERT INTO keyword_gaps (site_id, topic, reason, status, search_volume, coverage_status) VALUES ($1, $2, 'six-clients-test', 'pending_review', 30, 'opportunity')`, [S(k), topic]);
    await gap('admizz', 'uk student visa success rate nepal'); await gap('admizz', 'study in germany for nepali students');
    for (const k of ['chayce', 'zennly', 'zunkiree', 'superrank', 'mobilise']) await gap(k, `${k} fresh topic about visas and students`);
    const proposed = {};
    const base = { judge: async (_s, ts) => new Map(ts.map((t) => [t, accept()])), recentRelevance: async () => new Map(),
      gather: async () => ({ gsc: { relatedQueries: [], rankingPages: [] }, demand: null, coverage: { status: 'opportunity' }, signals: { detectors: [] } }),
      createProposal: async (siteId, c) => { (proposed[siteId] ||= []).push(c.topic); return { eligible: true, recommendationId: 5000 + siteId }; }, setDecisionRec: async () => {} };
    // Zunkiree's pool read fails: a fault in one client
    const deps = { ...base, poolCount: async (siteId) => { if (siteId === S('zunkiree')) throw new Error('simulated fault'); return (await import('../topic-research/store.js')).readyPoolCount(siteId); } };
    const sites = CLIENTS.map((c) => site[c.key]);
    const results = await research.runTopicResearchForAllSites({ sites, mode: 'on', deps, now: new Date('2026-11-25T07:00:00Z'), log: () => {} });
    const by = Object.fromEntries(CLIENTS.map((c, i) => [c.key, results[i]]));
    assert.equal(by.zunkiree.error, 'simulated fault'); assert.equal(proposed[S('zunkiree')], undefined, 'the failing client proposed nothing');
    for (const k of ['admizz', 'chayce', 'zennly', 'superrank', 'mobilise']) { assert.ok(!by[k].error, k); assert.ok(by[k].proposed >= 1, `${k} started research and proposed`); }
    assert.deepEqual(proposed[S('admizz')], ['study in germany for nepali students'], 'Admizz is not offered a topic it already published');
    assert.equal(by.admizz.rejected, 1);
    const adm = await log.listTopicDecisions(S('admizz'), { origin: 'research' });
    assert.match(adm.find((r) => r.topic === 'uk student visa success rate nepal').gates.find((g) => !g.ok).detail, /already published/);
    for (const k of ['chayce', 'zennly', 'superrank', 'mobilise']) assert.deepEqual(proposed[S(k)], [`${k} fresh topic about visas and students`], `${k} proposed only its own topic`);
    assert.equal((await log.listTopicDecisions(S('zunkiree'), { origin: 'research' })).length, 0);
  });

  test('a failed article is quarantined with its content kept while its siblings ship, and the decision log names it (per client)', async () => {
    const items = [1, 2, 3, 4, 5].map((i) => ({ id: i, topic: `visa article ${i}`, siteId: site.admizz.id }));
    const q = await import('./quarantine.js');
    const r = await pipeline.processArticlesIndependently(items, {
      generate: async (item) => ({ title: `Article ${item.id}`, sections: [{ heading: 'A', body: item.id === 3 ? '71% of applicants fail.' : 'Plain words.' }] }),
      validate: async (c) => ({ issues: /71%/.test(JSON.stringify(c)) ? [{ patternId: 'blog-unsupported-statistics', detail: 'unsourced statistic', blocking: true }] : [] }),
      quarantine: async (item, content, issues, repairs) => q.quarantineArticle(item.siteId, { topic: item.topic, content, issues, attempts: repairs + 1 }),
    });
    assert.deepEqual(r.validated.map((x) => x.item.id), [1, 2, 4, 5]); assert.deepEqual(r.quarantined.map((x) => x.item.id), [3]);
    const kept = await q.listQuarantinedArticles(site.admizz.id);
    assert.equal(kept.length, 1); assert.equal(kept[0].topic, 'visa article 3'); assert.match(JSON.stringify(kept[0].evidence.content), /71%/);
    assert.equal((await q.listQuarantinedArticles(site.chayce.id)).length, 0, 'another client has nothing quarantined');
  });
});
