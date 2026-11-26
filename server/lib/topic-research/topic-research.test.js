import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { denseWeeks, projectImpressions, seasonalLift, risingQueries, gapCandidates, mergeCandidates, DEFAULTS } from './signals.js';
import { runTopicResearchForSite, runTopicResearchForAllSites, topicResearchMode, poolTarget, maxProposalsPerCycle } from './research.js';
import { buildIndexEntries } from '../content-index/build.js';
import { checkTopicAgainstIndex } from '../content-index/check.js';
import { topicKey } from '../content-index/normalize.js';

const END = '2026-11-16'; // a Monday: the last full week
const weekStart = (back) => new Date(new Date(`${END}T00:00:00Z`).getTime() - back * 7 * 86_400_000).toISOString().slice(0, 10);
const series = (query, weekly) => weekly.map((impressions, i) => ({ query, week: weekStart(weekly.length - 1 - i), impressions, clicks: 0 }));

describe('predictive signals are computed from the real series, never invented', () => {
  test('denseWeeks fills missing weeks with real zeros, oldest first', () => {
    assert.deepEqual(denseWeeks([{ week: weekStart(0), impressions: 7 }, { week: weekStart(2), impressions: 3 }], { weeks: 4, endWeek: END }), [0, 3, 0, 7]);
  });
  test('projection: a rising line projects higher than the last week; a falling one never goes below zero; too little data says so', () => {
    const up = projectImpressions([10, 20, 30, 40, 50, 60, 70, 80], 2);
    assert.ok(up.slope > 9 && up.projected > 160, JSON.stringify(up)); assert.match(up.basis, /least-squares line over the last 8 weeks/);
    const down = projectImpressions([80, 60, 40, 20, 5, 0, 0, 0], 2); assert.ok(down.projected >= 0);
    const few = projectImpressions([5, 6], 2); assert.deepEqual([few.projected, few.slope], [null, null]); assert.match(few.basis, /only 2 weeks/);
  });
  test('seasonality needs 13 months; with less it says "insufficient history" instead of guessing; with enough it flags a real peak', () => {
    const short = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`2026-0${i + 1}`, 100]));
    const s = seasonalLift(short, 11); assert.equal(s.known, false); assert.match(s.reason, /only 6 month\(s\) of history; a seasonal read needs 13/);
    const months = {}; for (let y = 2025, m = 10, n = 0; n < 14; n++) { months[`${y}-${String(m).padStart(2, '0')}`] = (m === 11 && y === 2025) ? 900 : 100; if (++m > 12) { m = 1; y++; } }
    const long = seasonalLift(months, 11);
    assert.equal(long.known, true); assert.equal(long.seasonal, true); assert.ok(long.lift >= 1.3);
  });
});

describe('rising queries', () => {
  const site = { name: 'Admizz Education', website_domain: 'admizzeducation.com' };
  const rows = [
    ...series('uk student visa success rate nepal', [5, 5, 5, 5, 5, 5, 5, 5, 40, 45, 50, 55]),       // rising, not served by any page
    ...series('ielts band score requirements', [30, 30, 30, 30, 30, 30, 30, 30, 32, 31, 30, 33]),   // flat: not rising
    ...series('admizz education fees', [5, 5, 5, 5, 5, 5, 5, 5, 60, 60, 60, 60]),                   // brand query
    ...series('visa', [1, 1, 1, 1, 1, 1, 1, 1, 90, 90, 90, 90]),                                    // one word: too short
    ...series('study in canada cost of living', [2, 2, 2, 2, 2, 2, 2, 2, 50, 50, 50, 50]),           // a page already ranks #8
    ...series('new scholarship rules nepal students', [0, 0, 0, 0, 0, 0, 0, 0, 20, 25, 30, 35]),     // a brand-new query
    ...series('rare long tail question text', [0, 0, 0, 0, 0, 0, 0, 0, 3, 4, 3, 4]),                 // too little volume
  ];
  const best = new Map([['study in canada cost of living', { page: 'https://s.com/canada-cost', position: 8 }]]);
  test('only genuinely rising, unserved, non-brand, multi-word, high-enough queries qualify, each with its real series and a projection', () => {
    const r = risingQueries(rows, { bestPageByQuery: best, site, endWeek: END });
    assert.deepEqual(r.map((x) => x.query).sort(), ['new scholarship rules nepal students', 'uk student visa success rate nepal']);
    const v = r.find((x) => x.query.startsWith('uk student'));
    assert.deepEqual([v.priorWeeklyImpressions, v.recentWeeklyImpressions, v.isNew], [5, 48, false]); assert.ok(v.growth >= 9); assert.ok(v.projection.projected > 100);
    assert.equal(r.find((x) => x.query.startsWith('new scholarship')).isNew, true);
  });
  test('the projection orders candidates: the bigger projected demand comes first', () => {
    const r = risingQueries(rows, { bestPageByQuery: best, site, endWeek: END });
    assert.equal(r[0].query, 'uk student visa success rate nepal');
  });
  test('a page ranking beyond position 20 does not count as serving the query', () => {
    const r = risingQueries(rows, { bestPageByQuery: new Map([['study in canada cost of living', { page: 'p', position: 31 }]]), site, endWeek: END });
    assert.ok(r.some((x) => x.query === 'study in canada cost of living'));
  });
});

describe('merging every source into one candidate per topic', () => {
  test('a topic that is both rising and a competitor gap carries both; open recommendations and covered gaps are not proposed again', () => {
    const rising = risingQueries(series('uk student visa success rate nepal', [5, 5, 5, 5, 5, 5, 5, 5, 40, 45, 50, 55]), { endWeek: END, site: {} });
    const gaps = [
      { id: 1, topic: 'UK student visa success rate Nepal', status: 'pending_review', search_volume: 30, competitor_evidence: { rivals: 2 }, coverage_status: 'opportunity' },
      { id: 2, topic: 'part time jobs for international students', status: 'pending_review', search_volume: 500, coverage_status: 'duplicate' },
      { id: 3, topic: 'accommodation near london universities', status: 'approved', search_volume: 80, coverage_status: null },
      { id: 4, topic: 'already queued topic here', status: 'pending_review', recommendation_id: 77 },
      { id: 5, topic: 'visa interview questions uk', status: 'pending_review', search_volume: 60 },
    ];
    const merged = mergeCandidates({ rising, gaps, openTopics: ['Visa interview questions for the UK'], seasonal: { known: false, reason: 'only 3 month(s) of history; a seasonal read needs 13' } });
    const topics = merged.map((c) => c.topic);
    assert.ok(topics.includes('accommodation near london universities'));
    assert.ok(!topics.some((t) => /part time jobs/.test(t)), 'a covered gap is not a candidate');
    assert.ok(!topics.some((t) => /already queued/.test(t)), 'a gap that already has a recommendation is not a candidate');
    assert.ok(!topics.some((t) => /visa interview/.test(t)), 'an open recommendation on the same topic is not proposed twice');
    const both = merged.find((c) => c.origins.includes('rising-query'));
    assert.deepEqual(both.origins.sort(), ['keyword-gap', 'rising-query']); assert.equal(both.signals.competitor, true); assert.equal(both.demand.searchVolume, 30);
    assert.match(both.notes.join(' '), /seasonality: insufficient history/);
    assert.equal(gapCandidates(gaps).length, 3);
  });
});

describe('the research run (stand-in data sources)', () => {
  const site = { id: 8862, name: 'Admizz Education', timezone: 'Asia/Kolkata' };
  const NOW = new Date('2026-11-25T07:00:00Z');
  const topics = { fit: 'uk student visa success rate nepal', fit2: 'ielts requirements canadian universities', off: 'best crypto exchanges to buy bitcoin', dup: 'best courses for studying abroad 2026', cannibal: 'study in canada cost of living' };
  const verdicts = { [topics.fit]: { verdict: 'accept', reasons: ['relevant'], anchors: ['visa', 'student'], criteria: { addressesCustomerProblem: true, matchesAudience: true } }, [topics.fit2]: { verdict: 'accept', reasons: ['relevant'], anchors: ['ielts'], criteria: { matchesAudience: true } }, [topics.off]: { verdict: 'reject', reasons: ['not about what the company sells'], anchors: [] }, [topics.dup]: { verdict: 'accept', reasons: ['relevant'], anchors: ['courses'], criteria: {} }, [topics.cannibal]: { verdict: 'accept', reasons: ['relevant'], anchors: ['canada'], criteria: {} } };
  const entries = buildIndexEntries({ inventory: [{ page: 'https://s.com/best-courses-for-studying-abroad-in-2026' }], snapshots: [{ url: 'https://s.com/best-courses-for-studying-abroad-in-2026', title: 'Best courses for studying abroad in 2026', schema_types: ['BlogPosting'] }] });
  const gap = (id, topic, volume) => ({ id, topic, status: 'pending_review', search_volume: volume, coverage_status: 'opportunity' });
  const mk = (over = {}) => {
    const rec = { proposals: [], decisions: [], judged: [], gathered: [], decisionRecs: [] };
    return {
      rec,
      deps: {
        poolCount: async () => 0, recentProposals: async () => 0, loadSeries: async () => [], loadMonthly: async () => ({}), loadBestPages: async () => new Map(),
        loadGaps: async () => [gap(1, topics.fit, 15), gap(2, topics.fit2, 40), gap(3, topics.off, 90000), gap(4, topics.dup, 2000), gap(5, topics.cannibal, 300)], loadOpenTopics: async () => [],
        getIndex: async () => ({ entries }), recentRelevance: async () => new Map(), judge: async (_s, ts) => { rec.judged.push(...ts); return new Map(ts.map((t) => [t, verdicts[t]])); },
        gather: async (_s, _r, topic) => { rec.gathered.push(topic); return { gsc: { relatedQueries: [{ query: topic, impressions: 30 }], rankingPages: topic === topics.cannibal ? [{ page: 'https://s.com/canada-cost', query: topic, impressions: 800, position: 5 }] : [] }, demand: null, coverage: { status: 'opportunity' }, signals: { detectors: [] } }; },
        checkIndex: checkTopicAgainstIndex,
        record: async (_s, d) => { rec.decisions.push(d); return rec.decisions.length; },
        createProposal: async (_s, c) => { rec.proposals.push(c.topic); return { eligible: true, recommendationId: 1000 + rec.proposals.length }; },
        setDecisionRec: async (_s, did, rid) => { rec.decisionRecs.push([did, rid]); }, ...over,
      },
    };
  };
  const quiet = () => {};

  test('"on": low-volume high-fit topics are proposed, the off-business high-volume one, the duplicate and the cannibal are rejected, every decision is logged with reasons', async () => {
    const m = mk();
    const r = await runTopicResearchForSite(site, { mode: 'on', deps: m.deps, now: NOW, log: quiet });
    assert.deepEqual([r.pool, r.target, r.need], [0, 5, 5]);
    assert.deepEqual(m.rec.proposals.sort(), [topics.fit, topics.fit2].sort());
    assert.equal(r.proposed, 2);
    const by = Object.fromEntries(m.rec.decisions.filter((d) => d.origin === 'research').map((d) => [d.topic, d]));
    assert.equal(by[topics.fit].decision, 'accepted'); assert.equal(by[topics.fit].enforced, true);
    assert.equal(by[topics.off].decision, 'rejected'); assert.match(by[topics.off].gates.find((g) => !g.ok).detail, /not about what the company sells/);
    assert.equal(by[topics.dup].decision, 'rejected'); assert.match(by[topics.dup].gates.find((g) => g.gate === 'not-duplicate').detail, /already published/);
    assert.equal(by[topics.cannibal].decision, 'rejected'); assert.match(by[topics.cannibal].gates.find((g) => g.gate === 'no-cannibalisation').detail, /already ranks #5/);
    assert.ok(by[topics.fit].alternatives.length >= 3, 'the accepted topic lists the alternatives turned down and why');
    assert.ok(by[topics.fit].priority > by[topics.fit2].priority, 'stronger fit first');
    assert.equal(m.rec.decisionRecs.length, 2, 'each proposal is linked back to its decision row');
  });
  test('"log" (the default): the same decisions are made and logged, but NOTHING is created', async () => {
    const m = mk();
    const r = await runTopicResearchForSite(site, { deps: m.deps, now: NOW, log: quiet });
    assert.equal(r.mode, 'log'); assert.equal(m.rec.proposals.length, 0); assert.equal(r.proposed, 0); assert.equal(r.accepted, 2);
    assert.ok(m.rec.decisions.every((d) => d.enforced === false));
  });
  test('a full pool costs nothing: no data is read, no topic judged, and the run is logged', async () => {
    const m = mk({ poolCount: async () => 5, loadSeries: async () => { throw new Error('must not be read'); } });
    const r = await runTopicResearchForSite(site, { mode: 'on', deps: m.deps, now: NOW, log: quiet });
    assert.equal(r.skipped, 'pool-full'); assert.equal(m.rec.judged.length, 0); assert.equal(m.rec.decisions[0].origin, 'research-run'); assert.equal(m.rec.decisions[0].evidence.poolFull, true);
  });
  test('the pool target is the next cycle\'s need; a partly full pool asks only for the shortfall', async () => {
    const m = mk({ poolCount: async () => 4 });
    const r = await runTopicResearchForSite(site, { mode: 'on', deps: m.deps, now: NOW, log: quiet });
    assert.equal(r.need, 1); assert.equal(m.rec.proposals.length, 1); assert.equal(m.rec.proposals[0], topics.fit, 'only the single best topic is proposed');
  });
  test('the per-cycle proposal cap holds even when the pool needs more', async () => {
    const m = mk({ recentProposals: async () => 7 });
    const r = await runTopicResearchForSite(site, { mode: 'on', deps: m.deps, now: NOW, log: quiet });
    assert.equal(m.rec.proposals.length, 1); assert.equal(r.proposed, 1);
    const capped = mk({ recentProposals: async () => 8 });
    await runTopicResearchForSite(site, { mode: 'on', deps: capped.deps, now: NOW, log: quiet });
    assert.equal(capped.rec.proposals.length, 0);
  });
  test('EMPTY BACKLOG: research does not stop; with no candidates in the real data it proposes nothing, manufactures nothing, and says so in the log', async () => {
    const m = mk({ loadGaps: async () => [] });
    const r = await runTopicResearchForSite(site, { mode: 'on', deps: m.deps, now: NOW, log: quiet });
    assert.equal(r.skipped, 'no-candidates'); assert.equal(m.rec.proposals.length, 0);
    assert.match(m.rec.decisions[0].evidence.note, /nothing was proposed \(no quota is filled\)/);
  });
  test('when nothing passes the gates nothing is proposed even though the pool is empty (no quota)', async () => {
    const m = mk({ loadGaps: async () => [gap(3, topics.off, 90000), gap(4, topics.dup, 2000)] });
    const r = await runTopicResearchForSite(site, { mode: 'on', deps: m.deps, now: NOW, log: quiet });
    assert.equal(r.accepted, 0); assert.equal(m.rec.proposals.length, 0); assert.equal(r.rejected, 2);
  });
  test('topics judged recently are not judged again; unreadable relevance holds a topic, it never accepts it', async () => {
    const m = mk({ recentRelevance: async () => new Map([[topicKey(topics.fit), verdicts[topics.fit]]]) });
    await runTopicResearchForSite(site, { mode: 'on', deps: m.deps, now: NOW, log: quiet });
    assert.ok(!m.rec.judged.includes(topics.fit)); assert.ok(m.rec.judged.includes(topics.fit2));
    const u = mk({ judge: async () => new Map() });
    await runTopicResearchForSite(site, { mode: 'on', deps: u.deps, now: NOW, log: quiet });
    assert.equal(u.rec.proposals.length, 0);
  });
  test('an accepted topic the standard creator declines is logged, counted as not proposed, and the next one still goes ahead', async () => {
    let n = 0; const lines = [];
    const m = mk({ createProposal: async (_s, c) => { n++; return n === 1 ? { eligible: false, reason: 'no destination for new blog files' } : { eligible: true, recommendationId: 55 }; } });
    const r = await runTopicResearchForSite(site, { mode: 'on', deps: m.deps, now: NOW, log: (l) => lines.push(l) });
    assert.equal(r.proposed, 1); assert.ok(lines.some((l) => /not proposed \(no destination for new blog files\)/.test(l)));
  });
  test('"off" does nothing; an error returns the error and never throws', async () => {
    assert.equal((await runTopicResearchForSite(site, { mode: 'off', deps: mk().deps, now: NOW })).skipped, 'off');
    const r = await runTopicResearchForSite(site, { mode: 'on', deps: mk({ poolCount: async () => { throw new Error('db down'); } }).deps, now: NOW, log: quiet });
    assert.equal(r.error, 'db down');
  });
  test('ALL clients independently: one that throws never stops the others, and each gets its own result', async () => {
    const sites = [8862, 8864, 8871, 8872, 8874, 1].map((id) => ({ id, timezone: 'Asia/Kolkata' }));
    const seen = [];
    const deps = { ...mk().deps, poolCount: async (id) => { seen.push(id); if (id === 8871) throw new Error('hiccup'); return 0; } };
    const results = await runTopicResearchForAllSites({ sites, mode: 'log', deps, now: NOW, log: quiet });
    assert.deepEqual(seen.sort(), [1, 8862, 8864, 8871, 8872, 8874].sort());
    assert.equal(results.length, 6); assert.equal(results.find((r) => r.siteId === 8871).error, 'hiccup');
    assert.ok(results.filter((r) => r.siteId !== 8871).every((r) => !r.error && r.candidates === 5));
  });
  test('modes, pool target and cap come from the environment with safe defaults', () => {
    assert.equal(topicResearchMode({}), 'log'); assert.equal(topicResearchMode({ TOPIC_RESEARCH: 'on' }), 'on'); assert.equal(topicResearchMode({ TOPIC_RESEARCH: 'junk' }), 'log');
    assert.equal(poolTarget({}), 5); assert.equal(poolTarget({ BLOG_POOL_TARGET: '9', BLOG_DAY_MAX_BLOGS: '12' }), 9);
    assert.equal(maxProposalsPerCycle({}), 8); assert.equal(maxProposalsPerCycle({ BLOG_RESEARCH_MAX_PROPOSALS: '3' }), 3); assert.equal(maxProposalsPerCycle({ BLOG_RESEARCH_MAX_PROPOSALS: '0' }), 8);
    assert.equal(DEFAULTS.horizonWeeks, 2);
  });
});
