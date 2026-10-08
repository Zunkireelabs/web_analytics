import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandidates, buildTopicQueue } from './topic-queue.js';

const measured = (searchVolume) => ({ available: true, providerId: 'x', searchVolume, volumeTrend: null });

describe('mergeCandidates', () => {
  test('the same topic from two pipelines becomes ONE candidate carrying both sources', () => {
    // This is the merge the whole module exists for: as two rows, the fact
    // that a topic is both trending and searched is lost.
    const out = mergeCandidates([
      { topic: 'Study in India from Nepal', origin: 'keyword-gap', demand: measured(900) },
      { topic: 'study in india from nepal', origin: 'trend-radar', trend: { distinctSources: 3, newestAgeDays: 1 } },
    ]);

    assert.equal(out.length, 1);
    assert.deepEqual(out[0].sources.sort(), ['keyword-gap', 'trend-radar']);
    assert.equal(out[0].demand.searchVolume, 900);
    assert.deepEqual(out[0].trend, { distinctSources: 3, newestAgeDays: 1 });
  });

  test('the better-evidenced field wins per field, not per candidate', () => {
    const out = mergeCandidates([
      { topic: 'a', origin: 'trend-radar', demand: { available: false, searchVolume: null }, trend: { distinctSources: 2 } },
      { topic: 'a', origin: 'keyword-gap', demand: measured(500) },
    ]);

    assert.equal(out[0].demand.searchVolume, 500, 'real volume must replace an unavailable signal');
    assert.deepEqual(out[0].trend, { distinctSources: 2 }, 'and the headlines must survive the merge');
  });

  test('the more readable title is kept among topics that share one key', () => {
    const out = mergeCandidates([
      { topic: 'ai in education', origin: 'keyword-gap' },
      { topic: 'AI in Education!', origin: 'trend-radar' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].topic, 'AI in Education!');
  });

  test('a longer headline is a DIFFERENT topic, not the same one with a better title', () => {
    // The key is the identity. "AI in education" and "AI in education: what
    // changed in 2026" are two topics, and merging them would silently drop
    // one of the two pieces of work.
    const out = mergeCandidates([
      { topic: 'ai in education', origin: 'keyword-gap' },
      { topic: 'AI in education: what changed in 2026', origin: 'trend-radar' },
    ]);
    assert.equal(out.length, 2);
  });

  test('an unkeyable topic is dropped rather than creating a blank row', () => {
    assert.deepEqual(mergeCandidates([{ topic: '  ', origin: 'manual' }]), []);
  });
});

// One fake per dependency; nothing here touches a database or a provider.
function deps(over = {}) {
  const persisted = [];
  return {
    persisted,
    d: {
      getProvider: () => ({ fetchDemandBulk: async () => new Map() }),
      classifyCoverage: async () => ({ status: 'opportunity' }),
      activeClaim: async () => null,
      suppressionEnforcing: () => false,
      suppressionSet: async () => new Set(),
      persist: async (siteId, rows) => { persisted.push(...rows); return rows.length; },
      loadContext: async () => null,
      activeGoals: async () => [],
      existingByKeys: async () => new Map(),
      ...over,
    },
  };
}

describe('buildTopicQueue', () => {
  test('an empty batch does nothing at all — no provider call, no write', async () => {
    let providerCalls = 0;
    const { d, persisted } = deps({ getProvider: () => ({ fetchDemandBulk: async () => { providerCalls++; return new Map(); } }) });
    const out = await buildTopicQueue(1, [], { deps: d });

    assert.deepEqual(out.queued, []);
    assert.equal(providerCalls, 0);
    assert.equal(persisted.length, 0);
  });

  test('demand is fetched in ONE provider call for the whole batch', async () => {
    const calls = [];
    const { d } = deps({
      getProvider: () => ({
        fetchDemandBulk: async (topics) => {
          calls.push(topics);
          return new Map(topics.map((t) => [t, measured(1000)]));
        },
      }),
    });

    await buildTopicQueue(1, [
      { topic: 'a', origin: 'trend-radar' }, { topic: 'b', origin: 'trend-radar' }, { topic: 'c', origin: 'keyword-gap' },
    ], { deps: d });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].sort(), ['a', 'b', 'c']);
  });

  test('coverage goes through classifyGapCoverage, not through slug matching', async () => {
    const asked = [];
    const { d } = deps({
      classifyCoverage: async (siteId, gap, opts) => { asked.push({ gap, opts }); return { status: 'covered' }; },
    });

    const out = await buildTopicQueue(1, [{ topic: 'a', origin: 'trend-radar' }], { deps: d });

    assert.equal(asked[0].gap.topic, 'a');
    assert.equal(asked[0].opts.persist, false, 'a topic candidate has no gap row to write a verdict back to');
    assert.equal(asked[0].opts.allowLLM, false, 'queue scoring must not spend a model call per topic');
    assert.equal(out.queued.length, 0);
    assert.equal(out.dropped[0].dropped, 'already-covered');
  });

  test("a candidate's own coverage verdict is trusted and costs no second classification", async () => {
    let calls = 0;
    const { d } = deps({ classifyCoverage: async () => { calls++; return { status: 'covered' }; } });

    const out = await buildTopicQueue(1, [{ topic: 'a', origin: 'keyword-gap', coverageStatus: 'opportunity' }], { deps: d });

    assert.equal(calls, 0);
    assert.equal(out.queued.length, 1);
  });

  test('a topic another producer already owns is dropped, not scored', async () => {
    const { d } = deps({ activeClaim: async () => ({ id: 9, producer: 'daily-roster' }) });
    const out = await buildTopicQueue(1, [{ topic: 'a', origin: 'trend-radar', demand: measured(9000) }], { deps: d });

    assert.equal(out.queued.length, 0);
    assert.equal(out.dropped[0].dropped, 'claimed-by-another-producer');
  });

  test('suppressions are only read when enforcement is on', async () => {
    let setCalls = 0;
    const off = deps({ suppressionSet: async () => { setCalls++; return new Set(); } });
    await buildTopicQueue(1, [{ topic: 'a', origin: 'trend-radar' }], { deps: off.d });
    assert.equal(setCalls, 0);

    const on = deps({ suppressionEnforcing: () => true, suppressionSet: async () => { setCalls++; return new Set(); } });
    await buildTopicQueue(1, [{ topic: 'a', origin: 'trend-radar' }], { deps: on.d });
    assert.equal(setCalls, 1);
  });

  test('a suppressed topic is dropped with that reason', async () => {
    const { d } = deps({
      suppressionEnforcing: () => true,
      suppressionSet: async () => new Set(['topic:a:blog-outline']),
    });
    const out = await buildTopicQueue(1, [{ topic: 'a', origin: 'trend-radar', demand: measured(500) }], { deps: d });
    assert.equal(out.dropped[0].dropped, 'suppressed');
  });

  test('queued AND dropped topics are both persisted — the reason one was dropped is the useful part', async () => {
    const { d, persisted } = deps({
      classifyCoverage: async (siteId, gap) => ({ status: gap.topic === 'bad' ? 'duplicate' : 'opportunity' }),
    });

    await buildTopicQueue(1, [
      { topic: 'good', origin: 'keyword-gap', demand: measured(1000) },
      { topic: 'bad', origin: 'keyword-gap', demand: measured(9000) },
    ], { deps: d });

    assert.equal(persisted.length, 2);
    const bad = persisted.find((r) => r.topic === 'bad');
    assert.equal(bad.dropped, 'duplicate-of-existing-page');
    assert.ok(persisted.find((r) => r.topic === 'good').score > 0);
  });

  test('a failed write does not lose the ranking the caller already has', async () => {
    const { d } = deps({ persist: async () => { throw new Error('table missing'); } });
    const out = await buildTopicQueue(1, [{ topic: 'a', origin: 'keyword-gap', demand: measured(1000) }], { deps: d });

    assert.equal(out.queued.length, 1);
    assert.equal(out.persisted, 0);
  });

  test('a provider outage leaves every topic rankable on its other evidence', async () => {
    // The thing that must not happen: an outage silently reading as zero
    // demand for every topic and collapsing the ranking.
    const { d } = deps({ getProvider: () => ({ fetchDemandBulk: async () => { throw new Error('HTTP 502'); } }) });
    const out = await buildTopicQueue(1, [
      { topic: 'a', origin: 'trend-radar', trend: { distinctSources: 3, newestAgeDays: 0 } },
      { topic: 'b', origin: 'trend-radar', trend: { distinctSources: 1, newestAgeDays: 6 } },
    ], { deps: d });

    assert.equal(out.queued.length, 2);
    assert.deepEqual(out.queued.map((q) => q.topic), ['a', 'b'], 'the broader, fresher trend still ranks first');
  });

  test('goal alignment is only evaluated when the tenant has goals', async () => {
    const withGoals = deps({
      activeGoals: async () => [{ id: 1, goalType: 'increase_organic_traffic', objective: 'Grow organic traffic', importance: 1 }],
    });
    const out = await buildTopicQueue(1, [{ topic: 'a', origin: 'keyword-gap', demand: measured(1000) }], { deps: withGoals.d });
    assert.ok(out.queued[0].components.goalLevel);

    const noGoals = deps();
    const bare = await buildTopicQueue(1, [{ topic: 'a', origin: 'keyword-gap', demand: measured(1000) }], { deps: noGoals.d });
    assert.equal(bare.queued[0].components.goalMultiplier, 1, 'no goals must not zero every topic');
  });

  test('corroboration survives a cron boundary — a topic the trend feed queued last week is credited today', async () => {
    // The two pipelines run on different schedules and are never in memory
    // together. Without the prior-row read, "both trending and searched"
    // could only ever be noticed when both happened to land in one batch.
    const { d } = deps({
      existingByKeys: async () => new Map([['ai-in-education', {
        topic_key: 'ai-in-education', topic: 'AI in education', origin: 'trend-radar',
        sources: ['trend-radar'], demand: null, status: 'queued',
      }]]),
    });

    const out = await buildTopicQueue(1, [{ topic: 'AI in education', origin: 'keyword-gap', demand: measured(3000) }], { deps: d });

    assert.deepEqual(out.queued[0].components.sources.sort(), ['keyword-gap', 'trend-radar']);
    assert.equal(out.queued[0].components.corroborationMultiplier, 1.25);
  });

  test('a topic a previous cycle already shipped is dropped, not re-queued', async () => {
    // The page exists. Re-queueing it is exactly the duplicate work this
    // layer exists to prevent, and the claims ledger cannot catch it once
    // the claim has been released.
    const { d } = deps({
      existingByKeys: async () => new Map([['a', { topic_key: 'a', status: 'shipped', sources: ['trend-radar'] }]]),
    });

    const out = await buildTopicQueue(1, [{ topic: 'a', origin: 'keyword-gap', demand: measured(9000) }], { deps: d });

    assert.equal(out.queued.length, 0);
    assert.equal(out.dropped[0].dropped, 'already-shipped');
  });

  test('a prior row that is still only queued does not block re-scoring', async () => {
    const { d } = deps({
      existingByKeys: async () => new Map([['a', { topic_key: 'a', status: 'queued', sources: ['keyword-gap'] }]]),
    });
    const out = await buildTopicQueue(1, [{ topic: 'a', origin: 'keyword-gap', demand: measured(100) }], { deps: d });
    assert.equal(out.queued.length, 1);
  });

  test('the merged topic is scored once, with both sources credited', async () => {
    const { d, persisted } = deps({
      getProvider: () => ({ fetchDemandBulk: async (topics) => new Map(topics.map((t) => [t, measured(2000)])) }),
    });

    const out = await buildTopicQueue(1, [
      { topic: 'AI in education', origin: 'keyword-gap' },
      { topic: 'AI in education', origin: 'trend-radar', trend: { distinctSources: 3, newestAgeDays: 0 } },
    ], { deps: d });

    assert.equal(out.queued.length, 1);
    assert.equal(persisted.length, 1);
    assert.equal(out.queued[0].components.corroborationMultiplier, 1.25);
  });
});
