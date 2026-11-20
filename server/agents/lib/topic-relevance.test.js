import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateTopics, decide, anchorHits, contentStems, JUDGE_SYSTEM, acceptedOnly } from './topic-relevance.js';
import { normalizeProfile } from '../../lib/business-profile.js';

const ev = [{ source: 'page', ref: 'u', summary: 's', quote: 'q' }];
const F = (value) => ({ value, status: 'detected', confidence: 'high', evidence: ev });

// The two projects whose current recommendations were wrong.
const zennly = normalizeProfile({ fields: {
  ownIndustry: F({ label: 'Software (SaaS)' }), subIndustry: F('Spa and salon booking and management software'),
  productsServices: F([{ name: 'Online booking', description: 'Clients book appointments online' }, { name: 'Staff scheduling and payroll' }, { name: 'Payments and daily reconciliation' }]),
  targetCustomerIndustries: F(['Spas', 'Salons', 'Gyms', 'Wellness centers', 'Fitness studios']),
  targetCustomers: F([{ segment: 'Spa and salon owners' }]),
  customerProblems: F(['Double-bookings', 'Discount leakage', 'No-shows and empty gaps in the calendar', 'Time-consuming daily closing']),
  coreTopics: F(['salon booking software', 'appointment scheduling', 'client retention']),
} });
const superrank = normalizeProfile({ fields: {
  ownIndustry: F({ label: 'Software (SaaS)' }), subIndustry: F('AI SEO, GEO and AEO software'),
  productsServices: F([{ name: 'AI visibility tracking', description: 'Tracks how ChatGPT and Google AI Overviews mention your brand' }, { name: 'Automatic SEO fixes' }, { name: 'Technical SEO audit' }]),
  targetCustomers: F([{ segment: 'Marketers and agencies' }, { segment: 'Website owners' }]),
  customerProblems: F(['Website not cited in AI search answers', 'Unknown SEO issues holding the site back']),
  coreTopics: F(['AI search visibility', 'generative engine optimization', 'organic growth']),
} });
const ctx = (profile, status = 'canonical') => ({ status, profile, siteId: 1 });

// A judge that answers the way a careful reviewer would, so the decision logic and plumbing can be tested without a paid call.
// (The same topics are judged by a real Claude model in topic-relevance.llm.test.js.)
const scriptedJudge = (answers) => async (_profile, topics) => ({ results: topics.map((t, index) => ({ index, ...answers(t) })) });
const yes = { relatesToProduct: true, addressesCustomerProblem: true, matchesAudience: true, supportsGoals: true, hasOpportunity: true, verdict: 'accept', reason: 'relevant' };
const no = { relatesToProduct: false, addressesCustomerProblem: false, matchesAudience: true, supportsGoals: false, hasOpportunity: null, verdict: 'reject', reason: 'unrelated' };

describe('the decision rule is applied in code, not by the model', () => {
  test('accept needs relatesToProduct AND (a customer problem OR the audience)', () => {
    assert.equal(decide({ relatesToProduct: true, addressesCustomerProblem: true, matchesAudience: false, supportsGoals: true }).verdict, 'accept');
    assert.equal(decide({ relatesToProduct: true, addressesCustomerProblem: false, matchesAudience: true, supportsGoals: true }).verdict, 'accept');
    assert.equal(decide({ relatesToProduct: false, addressesCustomerProblem: true, matchesAudience: true, supportsGoals: true }).verdict, 'reject');
    assert.equal(decide({ relatesToProduct: true, addressesCustomerProblem: false, matchesAudience: false, supportsGoals: true }).verdict, 'reject');
    assert.equal(decide({ relatesToProduct: true, addressesCustomerProblem: true, matchesAudience: true, supportsGoals: false }).verdict, 'reject');
  });

  test('a model that says "accept" but answers the criteria against it is overruled', async () => {
    const liar = scriptedJudge(() => ({ ...no, verdict: 'accept', reason: 'looks fine' }));
    const [v] = await validateTopics(['Innovations in Fitness Equipment'], ctx(zennly), { judge: liar });
    assert.equal(v.verdict, 'reject');
    assert.ok(v.reasons.length >= 1);
  });

  test('missing opportunity data never makes a topic acceptable or unacceptable by itself', async () => {
    const [v] = await validateTopics(['How to stop double-bookings in a salon'], ctx(zennly), { judge: scriptedJudge(() => ({ ...yes, hasOpportunity: null })) });
    assert.equal(v.verdict, 'accept');
    assert.equal(v.criteria.hasOpportunity, null);
  });
});

describe('regression: the real wrong recommendations', () => {
  const ZENNLY_BAD = ['The Market Shift Towards Inclusive Fitness', 'Vitamins and Supplements Expanding into Family Wellness', 'The Rise of Boutique Fitness and Its Responsibilities', 'Innovations in Fitness Equipment: What’s Next?'];
  const ZENNLY_GOOD = ['What are the benefits of using salon management software?', 'How to stop double-bookings in a busy salon', 'How to reduce no-shows with online booking'];
  const SUPERRANK_BAD = ['Innovative battery technologies and their impact on energy consumption', 'New features and applications in data center technology', 'The rise of OpenAI and its valuation implications', 'Advancements in AI research methodologies'];
  const SUPERRANK_GOOD = ['What’s the best way to monitor Google AI Overviews step by step?', 'How to get your brand cited in ChatGPT answers', 'Technical SEO audit checklist for small sites'];

  // Judge that rejects whatever the company's anchors do not touch, the way the model is instructed to.
  const anchored = (profile) => scriptedJudge((t) => (anchorHits(t, profile).strong.length > 0 ? yes : no));

  test('Zennly: fitness and supplements topics are rejected, salon software topics are accepted', async () => {
    const bad = await validateTopics(ZENNLY_BAD, ctx(zennly), { judge: anchored(zennly) });
    assert.ok(bad.every((v) => v.verdict === 'reject'), JSON.stringify(bad.map((v) => [v.topic, v.verdict])));
    const good = await validateTopics(ZENNLY_GOOD, ctx(zennly), { judge: anchored(zennly) });
    assert.ok(good.every((v) => v.verdict === 'accept'), JSON.stringify(good.map((v) => [v.topic, v.verdict])));
  });

  test('SuperRank: battery, data-centre and AI-valuation news are rejected, AI search topics are accepted', async () => {
    const bad = await validateTopics(SUPERRANK_BAD, ctx(superrank), { judge: anchored(superrank) });
    assert.ok(bad.every((v) => v.verdict === 'reject'), JSON.stringify(bad.map((v) => [v.topic, v.verdict])));
    const good = await validateTopics(SUPERRANK_GOOD, ctx(superrank), { judge: anchored(superrank) });
    assert.ok(good.every((v) => v.verdict === 'accept'), JSON.stringify(good.map((v) => [v.topic, v.verdict])));
  });

  test('customer-industry keywords alone are not anchors: "wellness" and "gyms" do not ground a topic for Zennly', () => {
    assert.equal(anchorHits('Wellness trends for gyms and fitness studios', zennly).strong.length, 0);
    assert.ok(anchorHits('How to stop double-bookings', zennly).strong.length > 0);
  });
});

describe('without a model: conservative, never accepts on keywords', () => {
  const broken = async () => { throw new Error('model unavailable'); };

  test('a topic with no connection to the business is rejected, one that shares words is held for review, none is accepted', async () => {
    const v = await validateTopics(['Innovations in Fitness Equipment', 'Why salon booking software matters', 'Quarterly earnings of chip makers'], ctx(zennly), { judge: broken });
    assert.equal(v[0].verdict, 'reject');
    assert.equal(v[1].verdict, 'unknown');
    assert.equal(v[2].verdict, 'reject');
    assert.ok(v.every((x) => x.source === 'deterministic'));
    assert.equal(acceptedOnly(v).length, 0);
  });

  test('an unusable model answer falls back the same way', async () => {
    const v = await validateTopics(['Random news about cars'], ctx(zennly), { judge: async () => ({ nonsense: true }) });
    assert.equal(v[0].verdict, 'reject');
    assert.equal(v[0].source, 'deterministic');
  });
});

describe('without a verified business profile', () => {
  test('every topic is unknown and held, nothing is judged against a guess', async () => {
    for (const c of [null, { status: 'insufficient', profile: null }, { status: 'legacy-unverified', profile: zennly }]) {
      const v = await validateTopics(['Any topic', 'Another'], c, { judge: async () => { throw new Error('must not be called'); } });
      assert.ok(v.every((x) => x.verdict === 'unknown' && x.source === 'no-profile'));
    }
  });
});

describe('cost control', () => {
  test('all topics of a run are judged in ONE model call, and a large run is split into batches of 15', async () => {
    let calls = 0;
    const judge = async (_p, topics) => { calls += 1; assert.ok(topics.length <= 15); return { results: topics.map((t, index) => ({ index, ...yes })) }; };
    await validateTopics(Array.from({ length: 5 }, (_, i) => `topic ${i}`), ctx(zennly), { judge });
    assert.equal(calls, 1);
    calls = 0;
    const out = await validateTopics(Array.from({ length: 60 }, (_, i) => `topic ${i}`), ctx(zennly), { judge });
    assert.equal(calls, 4);
    assert.equal(out.length, 60);
  });

  test('results are matched to topics by index even if the model returns them out of order', async () => {
    const judge = async () => ({ results: [{ index: 1, ...no }, { index: 0, ...yes }] });
    const v = await validateTopics(['good one', 'bad one'], ctx(zennly), { judge });
    assert.equal(v[0].verdict, 'accept');
    assert.equal(v[1].verdict, 'reject');
  });

  test('empty and blank topics cost nothing', async () => {
    let calls = 0;
    const v = await validateTopics(['', '   ', null], ctx(zennly), { judge: async () => { calls += 1; return { results: [] }; } });
    assert.equal(calls, 0);
    assert.equal(v.length, 3);
  });
});

describe('the judge prompt', () => {
  test('tells the model the customers’ industries are not the company’s own and to be strict', () => {
    assert.match(JUDGE_SYSTEM, /customers' industries are not the company's own/i);
    assert.match(JUDGE_SYSTEM, /gym equipment, supplements or fitness trends is NOT relevant/);
    assert.match(JUDGE_SYSTEM, /General technology, science or business news is NOT relevant/);
    assert.match(JUDGE_SYSTEM, /If unsure, answer false/);
  });
  test('stems ignore stopwords and plurals', () => {
    const stems = contentStems('How to stop the Double-Bookings');
    assert.ok(stems.includes('stop') && stems.includes('book'));
    assert.ok(!stems.some((x) => ['how', 'the', 'to'].includes(x)));
    assert.equal(contentStems('Bookings and booking and booked').length, 1);
  });
});
