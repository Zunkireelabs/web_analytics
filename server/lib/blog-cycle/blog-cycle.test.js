import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTopic, findCannibalisation, collectEvidence, topicPriority, relevanceScore, GATE } from './evidence-gate.js';
import { validateBlogContent, findBlogCycleIssues, wordCount } from './article-gate.js';
import { processArticlesIndependently } from './pipeline.js';
import { applyBlogEvidenceGate } from './select.js';
import { blogCycleCeiling, blogGateMode, blogArticleGateMode } from './ceiling.js';
import { buildIndexEntries } from '../content-index/build.js';
import { checkTopicAgainstIndex } from '../content-index/check.js';
import { topicKey } from '../content-index/normalize.js';

const accept = (anchors = ['visa'], criteria = { addressesCustomerProblem: true, matchesAudience: true }) => ({ verdict: 'accept', reasons: ['relevant to what this business sells and its customers'], anchors, criteria });
const reject = (why = 'not about what the company sells or the problem it solves') => ({ verdict: 'reject', reasons: [why], anchors: [] });
const okIndex = { ok: true, matches: [] };
const gsc = (impressions = 12) => ({ relatedQueries: impressions ? [{ query: 'uk student visa success rate', impressions, clicks: 1, position: 31 }] : [], rankingPages: [] });
const failedGates = (r) => r.gates.filter((g) => !g.ok).map((g) => g.gate);

describe('the evidence gate: business relevance decides, never volume', () => {
  test('a LOW-volume topic that fits the business is accepted', () => {
    const r = evaluateTopic({ topic: 'uk student visa success rate for nepali students', relevance: accept(['visa', 'student']), index: okIndex, coverage: { status: 'opportunity' }, gsc: gsc(12), demand: { searchVolume: 20 } });
    assert.equal(r.decision, 'accepted'); assert.deepEqual(failedGates(r), []); assert.ok(r.priority > 0);
  });
  test('a HIGH-volume topic that does not fit the business is rejected, and the reason says why', () => {
    const r = evaluateTopic({ topic: 'best crypto exchanges 2027', relevance: reject('not about what the company sells'), index: okIndex, coverage: { status: 'opportunity' }, gsc: gsc(5000), demand: { searchVolume: 90000 } });
    assert.equal(r.decision, 'rejected'); assert.deepEqual(failedGates(r), [GATE.RELEVANCE]); assert.equal(r.priority, null);
    assert.match(r.reasons[0], /business-relevance: not about what the company sells/);
  });
  test('relevance that could not be judged is HELD (deferred), never accepted', () => {
    const r = evaluateTopic({ topic: 'x y z', relevance: { verdict: 'unknown', reasons: ['no verified business profile yet, so relevance cannot be judged'] }, index: okIndex, gsc: gsc(50), demand: { searchVolume: 5000 } });
    assert.equal(r.decision, 'deferred'); assert.match(r.reasons[0], /no verified business profile/);
    assert.equal(evaluateTopic({ topic: 'x', relevance: null, index: okIndex, gsc: gsc(50) }).decision, 'deferred');
  });
  test('volume only ORDERS relevant topics: strong fit with low volume outranks weak fit with huge volume', () => {
    const strong = evaluateTopic({ topic: 'a', relevance: accept(['visa', 'student'], { addressesCustomerProblem: true, matchesAudience: true }), index: okIndex, gsc: gsc(15), demand: { searchVolume: 30 } });
    const weak = evaluateTopic({ topic: 'b', relevance: accept([], { addressesCustomerProblem: false, matchesAudience: true }), index: okIndex, gsc: gsc(100000), demand: { searchVolume: 5_000_000 } });
    assert.equal(strong.decision, 'accepted'); assert.equal(weak.decision, 'accepted');
    assert.ok(strong.priority > weak.priority, `${strong.priority} should beat ${weak.priority}`);
  });
  test('volume cannot rescue a rejected topic however large; relevance score ignores volume entirely', () => {
    assert.equal(relevanceScore(reject()), 0);
    const base = relevanceScore(accept(['visa']));
    assert.equal(base, relevanceScore(accept(['visa'])));
    const withVolume = topicPriority({ relevance: reject(), evidence: [{ kind: 'search-demand', searchVolume: 9e9 }] });
    assert.ok(withVolume <= 10, 'an irrelevant topic cannot reach a relevant one');
  });
});

describe('the evidence gate: never duplicate, never cannibalise, never without evidence', () => {
  const entries = buildIndexEntries({ inventory: [{ page: 'https://s.com/uk-student-visa-success-rate-nepali-students-2027' }], snapshots: [{ url: 'https://s.com/uk-student-visa-success-rate-nepali-students-2027', title: 'UK Student Visa Success Rate for Nepal (2027)', schema_types: ['BlogPosting'] }] });
  test('a topic already published is rejected by the index, naming the page', () => {
    const index = checkTopicAgainstIndex({ topic: 'uk student visa success rate nepal', entries });
    const r = evaluateTopic({ topic: 'uk student visa success rate nepal', relevance: accept(), index, gsc: gsc() });
    assert.equal(r.decision, 'rejected'); assert.deepEqual(failedGates(r), [GATE.DUPLICATE]); assert.match(r.reasons[0], /already published/);
  });
  test('the coverage authority rejects a topic an existing page covers', () => {
    const r = evaluateTopic({ topic: 't', relevance: accept(), index: okIndex, coverage: { status: 'covered', url: 'https://s.com/page' }, gsc: gsc() });
    assert.deepEqual(failedGates(r), [GATE.COVERED]);
    assert.equal(evaluateTopic({ topic: 't', relevance: accept(), index: okIndex, coverage: { status: 'market_gap', url: 'https://s.com/p' }, gsc: gsc() }).decision, 'accepted', 'a market gap is an opportunity, not coverage');
  });
  test('cannibalisation: a page already ranking near the top for the topic queries blocks it; a weak or unrelated ranking does not', () => {
    const topic = 'best courses for studying abroad';
    const strong = { page: 'https://s.com/best-courses-abroad', query: 'best courses for studying abroad', impressions: 400, position: 6 };
    assert.equal(findCannibalisation({ topic, rankingPages: [strong] }).length, 1);
    assert.equal(findCannibalisation({ topic, rankingPages: [{ ...strong, position: 35 }] }).length, 0, 'ranking #35 is not competition');
    assert.equal(findCannibalisation({ topic, rankingPages: [{ ...strong, impressions: 3 }] }).length, 0, 'noise');
    assert.equal(findCannibalisation({ topic, rankingPages: [{ ...strong, query: 'study abroad scholarships' }] }).length, 0, 'a different query');
    assert.equal(findCannibalisation({ topic, rankingPages: [strong], targetUrl: strong.page }).length, 0, 'the article\'s own target page is not competition');
    const r = evaluateTopic({ topic, relevance: accept(), index: okIndex, gsc: { relatedQueries: [{ query: topic, impressions: 400 }], rankingPages: [strong] } });
    assert.deepEqual(failedGates(r), [GATE.CANNIBAL]); assert.match(r.reasons[0], /already ranks #6/);
  });
  test('no real evidence at all is a rejection; any one real signal is enough', () => {
    assert.deepEqual(failedGates(evaluateTopic({ topic: 't', relevance: accept(), index: okIndex, gsc: gsc(0) })), [GATE.EVIDENCE]);
    for (const [name, extra] of [['competitor', { signals: { competitor: true } }], ['trend', { signals: { trend: true } }], ['detector', { signals: { detectors: ['content-gap'] } }], ['demand', { demand: { searchVolume: 10 } }]]) {
      assert.equal(evaluateTopic({ topic: 't', relevance: accept(), index: okIndex, gsc: gsc(0), ...extra }).decision, 'accepted', name);
    }
    assert.deepEqual(collectEvidence({ demand: { searchVolume: 0 } }), [], 'zero volume is not evidence');
    assert.deepEqual(collectEvidence({ signals: { detectors: ['some-random-agent'] } }), [], 'only data-driven detectors count');
  });
  test('search data that was unavailable HOLDS the topic: competition could not be checked', () => {
    const r = evaluateTopic({ topic: 't', relevance: accept(), index: okIndex, gsc: { relatedQueries: [], rankingPages: [], unavailable: 'timeout' }, demand: { searchVolume: 50 } });
    assert.equal(r.decision, 'deferred'); assert.match(r.reasons[0], /search data was unavailable/);
  });
  test('a person-requested topic skips relevance, coverage and cannibalisation but NEVER the duplicate check', () => {
    const rank = { page: 'https://s.com/p', query: 't topic words', impressions: 900, position: 3 };
    const a = evaluateTopic({ topic: 't topic words', clientRequested: true, relevance: reject(), index: okIndex, coverage: { status: 'covered', url: 'https://s.com/p' }, gsc: { relatedQueries: [], rankingPages: [rank] } });
    assert.equal(a.decision, 'accepted');
    const dup = checkTopicAgainstIndex({ topic: 'uk student visa success rate nepal', entries });
    assert.equal(evaluateTopic({ topic: 'uk student visa success rate nepal', clientRequested: true, relevance: reject(), index: dup, gsc: gsc(0) }).decision, 'rejected');
  });
  test('every gate is reported even after the first failure, so the log is complete', () => {
    const r = evaluateTopic({ topic: 't', relevance: reject(), index: { ok: false, reason: 'already published', matches: [] }, coverage: { status: 'duplicate', url: 'u' }, gsc: gsc(0) });
    assert.equal(r.gates.length, 5); assert.deepEqual(failedGates(r), [GATE.RELEVANCE, GATE.DUPLICATE, GATE.COVERED, GATE.EVIDENCE]);
  });
});

describe('the cycle ceiling: five is a ceiling, never a quota', () => {
  test('default 5; BLOG_DAY_MAX_BLOGS can only lower it; BLOG_CYCLE_MAX can raise it up to the day max and 12', () => {
    assert.equal(blogCycleCeiling({}), 5);
    assert.equal(blogCycleCeiling({ BLOG_DAY_MAX_BLOGS: '6' }), 5);
    assert.equal(blogCycleCeiling({ BLOG_DAY_MAX_BLOGS: '3' }), 3);
    assert.equal(blogCycleCeiling({ BLOG_DAY_MAX_BLOGS: '12', BLOG_CYCLE_MAX: '8' }), 8);
    assert.equal(blogCycleCeiling({ BLOG_CYCLE_MAX: '99', BLOG_DAY_MAX_BLOGS: '12' }), 12);
    assert.equal(blogCycleCeiling({ BLOG_CYCLE_MAX: 'abc' }), 5);
  });
  test('modes default to log and fall back to log on junk', () => {
    assert.equal(blogGateMode({}), 'log'); assert.equal(blogGateMode({ BLOG_EVIDENCE_GATE: 'ENFORCE' }), 'enforce'); assert.equal(blogGateMode({ BLOG_EVIDENCE_GATE: 'x' }), 'log');
    assert.equal(blogArticleGateMode({}), 'log'); assert.equal(blogArticleGateMode({ BLOG_ARTICLE_GATE: 'off' }), 'off');
  });
});

describe('article validation: fabrication, duplicates, SEO, AEO, links', () => {
  const body = (extra = '') => ({ heading: 'H', body: `A real paragraph about visas and fees for students planning to study abroad. ${extra}` });
  const good = (over = {}) => ({
    title: 'How to prepare a strong UK student visa application', topic: 'uk visa application tips', metaDescription: 'x'.repeat(120), quickAnswer: 'Apply early and keep your documents consistent.',
    sections: [{ heading: 'Documents', body: 'See our [IELTS guide](/ielts-preparation) first. ' + 'word '.repeat(60) }, { heading: 'Timeline', body: 'plain words ' + 'text '.repeat(40) }], sources: [{ label: 'GOV.UK', url: 'https://www.gov.uk/x' }], ...over,
  });
  test('a clean article has no issues', () => assert.deepEqual(validateBlogContent(good()).issues, []));
  test('statistics with no verified source are a BLOCKING fabrication issue with a correction; with a verified source they pass', () => {
    const c = good({ sources: undefined, sections: [body('About 73% of applicants are refused because of documents. According to a recent study, interviews matter.')] });
    const r = validateBlogContent(c); const i = r.issues.find((x) => x.patternId === 'blog-unsupported-statistics');
    assert.ok(i && i.blocking === true); assert.match(i.correction, /Remove every statistic/); assert.ok(r.stats.hardClaims >= 1);
    assert.equal(validateBlogContent({ ...c, sources: [{ label: 'GOV.UK', url: 'https://www.gov.uk/x' }] }).issues.some((x) => x.patternId === 'blog-unsupported-statistics'), false);
    assert.equal(validateBlogContent(good({ sources: undefined, sections: [body('Many applicants struggle with documents.')] })).issues.some((x) => x.patternId === 'blog-unsupported-statistics'), false, 'no number, no claim');
  });
  test('a finished title that matches existing content is blocking', () => {
    const entries = buildIndexEntries({ inventory: [{ page: 'https://s.com/how-to-prepare-a-strong-uk-student-visa-application' }], snapshots: [{ url: 'https://s.com/how-to-prepare-a-strong-uk-student-visa-application', title: 'How to prepare a strong UK student visa application', schema_types: ['Article'] }] });
    const i = validateBlogContent(good(), { entries }).issues.find((x) => x.patternId === 'blog-duplicates-existing-content');
    assert.ok(i && i.blocking); assert.match(i.detail, /already published/);
  });
  test('a regenerated draft never matches ITSELF: an earlier draft or open PR of the same topic does not block its repair, only live content does', () => {
    const inflight = buildIndexEntries({ drafts: [{ id: 5, action_type: 'blog-outline', status: 'revision_requested', content: { topic: 'uk visa application tips', title: 'How to prepare a strong UK student visa application' } }, { id: 6, action_type: 'blog-outline', status: 'pr_opened', pr_state: 'open', content: { topic: 'uk visa application tips', title: 'How to prepare a strong UK student visa application' } }] });
    assert.equal(validateBlogContent(good(), { entries: inflight }).issues.some((x) => x.patternId === 'blog-duplicates-existing-content'), false);
    const merged = buildIndexEntries({ drafts: [{ id: 7, action_type: 'blog-outline', status: 'implemented', content: { topic: 'uk visa application tips', title: 'How to prepare a strong UK student visa application' } }] });
    assert.equal(validateBlogContent(good(), { entries: merged }).issues.some((x) => x.patternId === 'blog-duplicates-existing-content'), true);
  });
  test('SEO, AEO and link problems are reported but never block', () => {
    const r = validateBlogContent(good({ title: 'Short', metaDescription: '', quickAnswer: undefined, faqItems: undefined, sections: [{ heading: 'A', body: 'text' }, { heading: 'A', body: 'text' }] }));
    const ids = r.issues.map((x) => x.patternId).sort();
    assert.deepEqual(ids, ['blog-duplicate-headings', 'blog-missing-meta-description', 'blog-no-direct-answer', 'blog-no-internal-links', 'blog-title-length']);
    assert.ok(r.issues.every((x) => x.blocking === false));
    assert.equal(wordCount([{ body: 'a b c' }, { body: 'd e' }]), 5);
  });
  test('the Quality Gate hook: blog-outline only; log mode never blocks; enforce blocks; off is silent; an unreadable index only skips the duplicate check', async () => {
    const bad = good({ sources: undefined, sections: [body('Over 80% of students fail.')] });
    const none = async () => [];
    assert.deepEqual(await findBlogCycleIssues('faq', bad, 1, { mode: 'enforce', getEntries: none }), []);
    assert.deepEqual(await findBlogCycleIssues('blog-outline', bad, 1, { mode: 'off', getEntries: none }), []);
    const logged = await findBlogCycleIssues('blog-outline', bad, 1, { mode: 'log', getEntries: none });
    assert.ok(logged.length && logged.every((i) => i.blocking === false));
    const enforced = await findBlogCycleIssues('blog-outline', bad, 1, { mode: 'enforce', getEntries: none });
    assert.ok(enforced.some((i) => i.blocking === true));
    const broken = await findBlogCycleIssues('blog-outline', bad, 1, { mode: 'enforce', getEntries: async () => { throw new Error('db down'); } });
    assert.ok(broken.some((i) => i.patternId === 'blog-unsupported-statistics'));
  });
});

describe('one failed article never blocks the others', () => {
  const items = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, topic: `topic ${i + 1}` }));
  const stubs = ({ badIds = [], throwIds = [], fixableIds = [] } = {}) => {
    const generated = []; const recorded = []; const quarantinedList = [];
    return {
      generated, recorded, quarantinedList,
      deps: {
        generate: async (item, feedback) => { generated.push([item.id, !!feedback]); if (throwIds.includes(item.id)) throw new Error('generator refused'); return { id: item.id, fixed: !!feedback }; },
        validate: async (c) => ({ issues: badIds.includes(c.id) || (fixableIds.includes(c.id) && !c.fixed) ? [{ patternId: 'bad', detail: 'unsupported statistic', correction: 'remove it', blocking: true }] : [] }),
        record: async (item, r) => { recorded.push([item.id, r.outcome]); },
        quarantine: async (item, content, issues) => { quarantinedList.push([item.id, content, issues.length]); },
      },
    };
  };
  test('five articles, one bad and one throwing: the other three are validated and delivered, the bad one is quarantined with its content kept', async () => {
    const s = stubs({ badIds: [2], throwIds: [4] });
    const r = await processArticlesIndependently(items(5), s.deps);
    assert.deepEqual(r.validated.map((x) => x.item.id), [1, 3, 5]);
    assert.deepEqual(r.quarantined.map((x) => x.item.id), [2]);
    assert.deepEqual(r.failed.map((x) => x.item.id), [4]);
    assert.deepEqual(s.quarantinedList[0].slice(0, 1), [2]); assert.equal(s.quarantinedList[0][1].id, 2, 'the content is handed to quarantine, not dropped');
    assert.equal(s.recorded.length, 5, 'every article has an outcome recorded');
  });
  test('a failing article is repaired with the feedback, bounded, and then passes', async () => {
    const s = stubs({ fixableIds: [1] });
    const r = await processArticlesIndependently(items(1), s.deps);
    assert.equal(r.validated.length, 1); assert.equal(r.validated[0].repairs, 1);
    assert.deepEqual(s.generated, [[1, false], [1, true]], 'the second generation received the correction');
  });
  test('repairs are bounded: a permanently bad article is generated 1 + maxRepairs times, then quarantined', async () => {
    const s = stubs({ badIds: [1] });
    const r = await processArticlesIndependently(items(1), s.deps, { maxRepairs: 2 });
    assert.equal(s.generated.length, 3); assert.equal(r.quarantined.length, 1); assert.equal(r.quarantined[0].repairs, 2);
  });
  test('the ceiling stops at five VALIDATED articles; a quarantined one does not use a slot; extras are skipped, not failed', async () => {
    const s = stubs({ badIds: [1] });
    const r = await processArticlesIndependently(items(8), s.deps, { ceiling: 5 });
    assert.equal(r.validated.length, 5); assert.deepEqual(r.validated.map((x) => x.item.id), [2, 3, 4, 5, 6]);
    assert.deepEqual(r.skipped.map((x) => x.item.id), [7, 8]);
  });
  test('fewer eligible than the ceiling ships fewer; none ships none (nothing manufactured)', async () => {
    assert.equal((await processArticlesIndependently(items(2), stubs().deps, { ceiling: 5 })).validated.length, 2);
    const none = await processArticlesIndependently([], stubs().deps, { ceiling: 5 });
    assert.deepEqual([none.validated.length, none.quarantined.length, none.failed.length, none.results.length], [0, 0, 0, 0]);
  });
  test('a recorder or quarantine that throws never stops the cycle', async () => {
    const s = stubs({ badIds: [1] }); s.deps.record = async () => { throw new Error('db down'); }; s.deps.quarantine = async () => { throw new Error('db down'); };
    const r = await processArticlesIndependently(items(3), s.deps);
    assert.deepEqual([r.validated.length, r.quarantined.length], [2, 1]);
  });
});

describe('the batch gate in the shipping loop (stand-in data sources)', () => {
  const site = { id: 8862, timezone: 'Asia/Kolkata' };
  const rec = (id, topic, extra = {}) => ({ id, recommendation_type: 'blog-outline', params: { topic }, detecting_agents: ['content-gap'], ...extra });
  const fix = (id) => ({ id, recommendation_type: 'meta-title', params: {} });
  const topics = {
    fit1: 'uk student visa success rate nepali students', fit2: 'ielts requirements canadian universities', offTopic: 'best crypto exchanges', dup: 'best courses for studying abroad 2026', unknown: 'scholarships india nepali students',
  };
  const verdicts = { [topics.fit1]: accept(['visa', 'student']), [topics.fit2]: accept(['ielts']), [topics.offTopic]: reject(), [topics.dup]: accept(['courses']), [topics.unknown]: { verdict: 'unknown', reasons: ['relevance could not be judged'] } };
  const entries = buildIndexEntries({ inventory: [{ page: 'https://s.com/best-courses-for-studying-abroad-in-2026' }], snapshots: [{ url: 'https://s.com/best-courses-for-studying-abroad-in-2026', title: 'Best courses for studying abroad in 2026', schema_types: ['BlogPosting'] }] });
  const mkDeps = (over = {}) => {
    const recorded = []; const judged = [];
    return {
      recorded, judged,
      deps: {
        getIndex: async () => ({ entries }), judge: async (_s, ts) => { judged.push(...ts); return new Map(ts.map((t) => [t, verdicts[t]])); },
        gather: async () => ({ gsc: gsc(25), demand: { searchVolume: 40 }, coverage: { status: 'opportunity' }, signals: { detectors: ['content-gap'] } }),
        record: async (_s, d) => { recorded.push(d); return recorded.length; }, recentRelevance: async () => new Map(), ...over,
      },
    };
  };
  const eligible = () => [fix(1), rec(10, topics.offTopic), rec(11, topics.fit2), fix(2), rec(12, topics.dup), rec(13, topics.fit1), rec(14, topics.unknown)];

  test('enforce: only evidence-accepted blogs continue, best first, every non-blog keeps its place, and every decision is recorded with its reasons', async () => {
    const m = mkDeps();
    const r = await applyBlogEvidenceGate(site, eligible(), { mode: 'enforce', deps: m.deps });
    assert.equal(r.kept.length, 4, 'two fixes and the two accepted blogs');
    assert.deepEqual(r.kept.filter((x) => x.recommendation_type === 'blog-outline').map((x) => x.id).sort(), [11, 13]);
    assert.deepEqual(r.kept.filter((x) => x.recommendation_type !== 'blog-outline').map((x) => x.id), [1, 2], 'the other generators are untouched and in order');
    assert.equal(m.recorded.length, 5);
    const by = Object.fromEntries(m.recorded.map((d) => [d.recommendationId, d.decision]));
    assert.deepEqual(by, { 10: 'rejected', 11: 'accepted', 12: 'rejected', 13: 'accepted', 14: 'deferred' });
    assert.ok(m.recorded.find((d) => d.recommendationId === 13).alternatives.length >= 3, 'an accepted topic lists the alternatives turned down and why');
    assert.ok(m.recorded.every((d) => d.enforced === true));
    assert.equal(r.kept.filter((x) => x.recommendation_type === 'blog-outline')[0].id, 13, 'the better-fitting topic (more anchors) goes first');
  });
  test('log mode (the default) records every decision but changes nothing about what ships', async () => {
    const m = mkDeps(); const list = eligible();
    const r = await applyBlogEvidenceGate(site, list, { deps: m.deps });
    assert.equal(r.kept, list); assert.equal(m.recorded.length, 5); assert.ok(m.recorded.every((d) => d.enforced === false));
    assert.match(r.notes[0], /\(log\): 2 of 5 topic\(s\) accepted/);
  });
  test('off does nothing at all; no blogs means nothing is loaded', async () => {
    const m = mkDeps({ getIndex: async () => { throw new Error('should not be called'); } });
    const list = eligible();
    assert.equal((await applyBlogEvidenceGate(site, list, { mode: 'off', deps: m.deps })).kept, list);
    const noBlogs = [fix(1), fix(2)];
    assert.equal((await applyBlogEvidenceGate(site, noBlogs, { mode: 'enforce', deps: m.deps })).kept, noBlogs);
  });
  test('topics judged recently are not judged again (no model call per pass)', async () => {
    const m = mkDeps({ recentRelevance: async () => new Map([[topicKey(topics.fit1), verdicts[topics.fit1]]]) });
    const r = await applyBlogEvidenceGate(site, [rec(13, topics.fit1), rec(11, topics.fit2)], { mode: 'enforce', deps: m.deps });
    assert.deepEqual(m.judged, [topics.fit2], 'only the topic with no recent verdict was sent to the judge');
    assert.deepEqual(r.kept.map((x) => x.id).sort(), [11, 13], 'the reused verdict still accepts the topic');
  });
  test('an error in enforce mode holds the blogs and lets every other fix through; in log mode it is ignored', async () => {
    const m = mkDeps({ getIndex: async () => { throw new Error('boom'); } });
    const quiet = () => {};
    const e = await applyBlogEvidenceGate(site, eligible(), { mode: 'enforce', deps: m.deps, log: quiet });
    assert.deepEqual(e.kept.map((x) => x.id), [1, 2]); assert.match(e.notes[0], /blogs held this pass/);
    const list = eligible();
    const l = await applyBlogEvidenceGate(site, list, { mode: 'log', deps: m.deps, log: quiet });
    assert.equal(l.kept, list);
  });
  test('a blog whose recommendation names no topic is turned away, not guessed at', async () => {
    const m = mkDeps();
    const r = await applyBlogEvidenceGate(site, [{ id: 99, recommendation_type: 'blog-outline', params: {} }], { mode: 'enforce', deps: m.deps });
    assert.deepEqual(r.kept, []); assert.equal(m.recorded[0].decision, 'rejected');
  });
});
