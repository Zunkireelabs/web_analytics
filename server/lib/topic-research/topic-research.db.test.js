// Real SQL against the LOCAL throwaway database (srtest on sr-local-pg, port 55432). Skipped unless DATABASE_URL points there.
//   DB_SSL=off DATABASE_URL=postgres://postgres:<local password>@localhost:55432/srtest node --experimental-test-module-mocks --test server/lib/topic-research/topic-research.db.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = /@(localhost|127\.0\.0\.1):55432\//.test(process.env.DATABASE_URL || '');
const SITE = 1;
const TAG = 'tr-db-test';

describe('topic research and the decision log against a real Postgres (migration 270)', { skip: !LOCAL }, () => {
  let db; let log; let st; let research; let quarantine; let checkMod; let buildMod;
  const clean = async () => {
    await db.query(`DELETE FROM topic_decisions WHERE site_id = $1`, [SITE]);
    await db.query(`DELETE FROM recommendations WHERE site_id = $1 AND finding_ids && ARRAY['${TAG}:1','${TAG}:2']`, [SITE]);
    await db.query(`DELETE FROM drafts WHERE site_id = $1 AND source = $2`, [SITE, TAG]);
    await db.query(`DELETE FROM gsc_query_page WHERE site_id = $1 AND device = $2`, [SITE, TAG]);
    await db.query(`DELETE FROM keyword_gaps WHERE site_id = $1 AND reason = $2`, [SITE, TAG]);
  };
  before(async () => {
    db = await import('../../db.js'); log = await import('./decision-log.js'); st = await import('./store.js'); research = await import('./research.js');
    quarantine = await import('../blog-cycle/quarantine.js'); checkMod = await import('../content-index/check.js'); buildMod = await import('../content-index/build.js'); await clean();
  });
  after(async () => { await clean(); await db.pool?.end?.(); });

  test('the decision log: a decision is stored with its gates and alternatives; one row per topic and decision per day; listing and the summary read it back', async () => {
    const d = { topic: 'uk student visa success rate nepal', decision: 'accepted', origin: 'gate', gates: [{ gate: 'business-relevance', ok: true, detail: 'relevant' }], evidence: { items: [{ kind: 'search-impressions', impressions: 12 }] }, relevance: { verdict: 'accept', anchors: ['visa'] }, priority: 58.2, alternatives: [{ topic: 'best crypto', why: 'not relevant' }], enforced: true };
    const id = await log.recordTopicDecision(SITE, d, { dedupeToday: true });
    assert.ok(id);
    assert.equal(await log.recordTopicDecision(SITE, d, { dedupeToday: true }), null, 'the same topic and decision the same day is not written twice');
    assert.ok(await log.recordTopicDecision(SITE, { ...d, decision: 'rejected', gates: [{ gate: 'not-duplicate', ok: false, detail: 'already published' }] }, { dedupeToday: true }), 'a different decision is');
    const rows = await log.listTopicDecisions(SITE, { limit: 10 });
    assert.equal(rows.length, 2); assert.equal(rows.find((r) => r.decision === 'accepted').alternatives[0].why, 'not relevant'); assert.equal(Number(rows.find((r) => r.decision === 'accepted').priority), 58.2);
    assert.equal((await log.listTopicDecisions(SITE, { decision: 'rejected' })).length, 1);
    const sum = await log.summarizeTopicDecisions(SITE, { days: 1 });
    assert.deepEqual(sum.byDecision, { accepted: 1, rejected: 1 }); assert.deepEqual(sum.turnedAwayBecause, { 'not-duplicate': 1 });
    assert.equal(await log.recordTopicDecision(SITE, { topic: 'x', decision: 'maybe' }), null, 'a bad decision value is refused and never throws');
  });

  test('recent relevance verdicts: only accept and reject are reused (unknown is retried), newest wins', async () => {
    await db.query(`DELETE FROM topic_decisions WHERE site_id = $1`, [SITE]);
    await log.recordTopicDecision(SITE, { topic: 'ielts preparation guide', decision: 'rejected', relevance: { verdict: 'reject' } });
    await log.recordTopicDecision(SITE, { topic: 'ielts preparation guide', decision: 'accepted', relevance: { verdict: 'accept' } });
    await log.recordTopicDecision(SITE, { topic: 'scholarships guide students', decision: 'deferred', relevance: { verdict: 'unknown' } });
    const { topicKey } = await import('../content-index/normalize.js');
    const m = await log.recentRelevanceVerdicts(SITE, [topicKey('ielts preparation guide'), topicKey('scholarships guide students')]);
    assert.equal(m.get(topicKey('ielts preparation guide')).verdict, 'accept'); assert.equal(m.has(topicKey('scholarships guide students')), false);
  });

  test('quarantine keeps the failed article\'s full content and its exact issues, and lists it back', async () => {
    await db.query(`DELETE FROM topic_decisions WHERE site_id = $1`, [SITE]);
    const content = { title: 'Visa tips', sections: [{ heading: 'A', body: '73% of applicants fail.' }] };
    const id = await quarantine.quarantineArticle(SITE, { topic: 'visa tips', content, issues: [{ patternId: 'blog-unsupported-statistics', detail: 'unsourced statistic', blocking: true }], attempts: 3, recommendationId: 41 });
    assert.ok(id);
    const [q] = await quarantine.listQuarantinedArticles(SITE);
    assert.equal(q.topic, 'visa tips'); assert.deepEqual(q.evidence.content, content); assert.equal(q.gates[0].gate, 'blog-unsupported-statistics'); assert.equal(q.evidence.attempts, 3);
  });

  test('the ready pool counts accepted open blog topics with no live draft; an abandoned draft frees it; an old decision does not count', async () => {
    await db.query(`DELETE FROM topic_decisions WHERE site_id = $1`, [SITE]);
    const rec = async (n) => (await db.query(`INSERT INTO recommendations (site_id, page, recommendation_type, issue, params, finding_ids) VALUES ($1, $2, 'blog-outline', 'topic', $3::jsonb, ARRAY[$4]) RETURNING id`, [SITE, `topic:${TAG}-${n}`, JSON.stringify({ topic: `pool topic ${n}` }), `${TAG}:${n}`])).rows[0].id;
    const r1 = await rec(1); const r2 = await rec(2);
    assert.equal(await st.readyPoolCount(SITE), 0, 'no accepted decision yet');
    await log.recordTopicDecision(SITE, { topic: 'pool topic 1', decision: 'accepted', recommendationId: r1 });
    await log.recordTopicDecision(SITE, { topic: 'pool topic 2', decision: 'rejected', recommendationId: r2 });
    assert.equal(await st.readyPoolCount(SITE), 1);
    const d = (await db.query(`INSERT INTO drafts (site_id, action_type, source, input, content, status, finding_id) VALUES ($1, 'blog-outline', $2, '{}', '{}', 'submitted_for_approval', $3) RETURNING id`, [SITE, TAG, `${TAG}:1`])).rows[0].id;
    assert.equal(await st.readyPoolCount(SITE), 0, 'a live draft means it is no longer waiting to be written');
    await db.query(`UPDATE drafts SET status = 'abandoned' WHERE id = $1`, [d]);
    assert.equal(await st.readyPoolCount(SITE), 1, 'an abandoned draft frees the topic again');
    await db.query(`UPDATE topic_decisions SET created_at = now() - interval '20 days' WHERE site_id = $1`, [SITE]);
    assert.equal(await st.readyPoolCount(SITE), 0, 'a decision older than the window is stale');
  });

  test('the proposal cap counts only enforced research acceptances inside the window', async () => {
    await db.query(`DELETE FROM topic_decisions WHERE site_id = $1`, [SITE]);
    await log.recordTopicDecision(SITE, { topic: 'a b c', decision: 'accepted', origin: 'research', enforced: true });
    await log.recordTopicDecision(SITE, { topic: 'd e f', decision: 'accepted', origin: 'research', enforced: false });
    await log.recordTopicDecision(SITE, { topic: 'g h i', decision: 'accepted', origin: 'gate', enforced: true });
    assert.equal(await st.recentProposalCount(SITE), 1);
  });

  test('a full research run with the real loaders: rising query found in GSC history, gap read, gated, decisions persisted; log mode creates nothing', async () => {
    await db.query(`DELETE FROM topic_decisions WHERE site_id = $1`, [SITE]);
    // 12 weeks of history for one rising query and one flat one, plus a page that already ranks #6 for the flat one
    const mon = (back) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7 * back + 1); return d.toISOString().slice(0, 10); };
    const put = (query, page, date, impressions, position) => db.query(`INSERT INTO gsc_query_page (site_id, date, query, page, clicks, impressions, ctr, position, device, country) VALUES ($1, $2, $3, $4, 0, $5, 0, $6, $7, '')`, [SITE, date, query, page, impressions, position, TAG]);
    for (let w = 11; w >= 0; w--) {
      await put('uk visa interview questions nepal', 'https://ci.example/other', mon(w), w <= 3 ? 45 : 4, 28);
      await put('ielts band score requirements', 'https://ci.example/ielts', mon(w), 30, 6);
    }
    await db.query(`INSERT INTO keyword_gaps (site_id, topic, reason, status, search_volume, coverage_status) VALUES ($1, 'accommodation near london universities', $2, 'pending_review', 70, 'opportunity')`, [SITE, TAG]);
    const created = [];
    const deps = {
      getIndex: async () => ({ entries: [] }), judge: async (_s, ts) => new Map(ts.map((t) => [t, { verdict: 'accept', reasons: ['relevant'], anchors: ['visa'], criteria: { matchesAudience: true } }])),
      recentRelevance: async () => new Map(), gather: async (_s, _r, topic) => ({ gsc: { relatedQueries: [], rankingPages: [] }, demand: null, coverage: { status: 'opportunity' }, signals: { detectors: [] } }),
      createProposal: async (_s, c) => { created.push(c.topic); return { eligible: true, recommendationId: 9 }; }, setDecisionRec: async () => {},
    };
    const r = await research.runTopicResearchForSite({ id: SITE, name: 'Zunkiree Labs', website_domain: 'zunkireelabs.com', timezone: 'Asia/Kolkata' }, { mode: 'log', deps, log: () => {} });
    assert.ok(r.candidates >= 2, JSON.stringify(r));
    const rows = await log.listTopicDecisions(SITE, { origin: 'research', limit: 20 });
    const topics = rows.map((x) => x.topic);
    assert.ok(topics.includes('uk visa interview questions nepal'), 'the rising query was found in the real GSC history');
    assert.ok(topics.includes('accommodation near london universities'), 'the open keyword gap was read');
    assert.ok(!topics.includes('ielts band score requirements'), 'a flat query that a page already serves is not a candidate');
    const rising = rows.find((x) => x.topic === 'uk visa interview questions nepal');
    assert.equal(rising.decision, 'accepted'); assert.match(rising.evidence.notes.join(' '), /recent weekly impressions .* vs .* before/); assert.ok(rising.evidence.projection.projected > 0);
    assert.equal(created.length, 0, 'log mode creates nothing');
    assert.ok(rows.every((x) => x.enforced === false));
  });

  test('createProposal builds the recommendation the standard way and reports honestly when it cannot', async () => {
    const calls = [];
    const deps = {
      saveKeywordGaps: async (s, gaps, source) => calls.push(['save', gaps[0].topic, source]), updateKeywordGapStatus: async (s, id, status) => { calls.push(['status', id, status]); return { status }; },
      linkGap: async (gid, rid) => calls.push(['link', gid, rid]), findGap: async () => ({ id: 77, topic: 'x y z' }), create: async (s, gap, opts) => { calls.push(['create', gap.id, opts.deferDraft]); return { recommendationId: 501 }; },
    };
    const ok = await st.createProposal(SITE, { topic: 'x y z', demand: { searchVolume: 12 } }, { deps });
    assert.deepEqual(ok, { eligible: true, recommendationId: 501, gapId: 77 });
    assert.deepEqual(calls, [['save', 'x y z', 'internal_analysis'], ['status', 77, 'approved'], ['create', 77, true], ['link', 77, 501]]);
    calls.length = 0;
    await st.createProposal(SITE, { topic: 'x y z', gapId: 77 }, { deps });
    assert.ok(!calls.some((c) => c[0] === 'save'), 'an existing gap is reused, not duplicated');
    assert.equal((await st.createProposal(SITE, { topic: 'q' }, { deps: { ...deps, findGap: async () => null } })).eligible, false);
    assert.equal((await st.createProposal(SITE, { topic: 'q' }, { deps: { ...deps, create: async () => ({ eligible: false, dropped: 'no destination for new blog files' }) } })).reason, 'no destination for new blog files');
  });

  test('the content index and the research gate agree: a topic the index holds in ANY state is never proposed (stored index, real tables)', async () => {
    const entries = buildMod.buildIndexEntries({ drafts: [{ id: 1, action_type: 'blog-outline', status: 'pr_opened', pr_state: 'open', pr_url: 'https://github.com/o/r/pull/70', content: { topic: 'student accommodation london', title: 'Student accommodation in London' } }] });
    assert.equal(checkMod.checkTopicAgainstIndex({ topic: 'student accommodation in london', entries }).ok, false);
  });
});
