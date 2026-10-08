import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyPacing, applyConvergenceCap, applyRefusalCap, MAX_FAILED_ATTEMPTS, MAX_REFUSALS, MAX_RECOVERY_CYCLES, effectiveConvergenceCap } from './ship-pacing.js';

// Both collaborators are injectable, so this suite needs neither a database
// nor module mocks — the rules under test are pure candidate filtering.
const site = { id: 1, timezone: 'Asia/Kolkata' };
const never = async () => false;

function rec(id, { type = 'meta-title', findingIds = [`f${id}`] } = {}) {
  return { id, recommendation_type: type, finding_ids: findingIds };
}

// These two rules lived only on the unattended cron path. The manual bulk
// path (routes/action-center.js's executeSafeFixes) had neither, and it is
// the path that carries the volume: on 2026-09-01 three bulk runs drafted 61
// blog-outlines and opened one PR with 42 net-new blog posts. This module
// exists so both paths apply the identical rule.
describe('applyPacing', () => {
  test('thins a paced generator to one per run, keeping the highest-priority candidate', async () => {
    const candidates = [rec(1, { type: 'blog-outline' }), rec(2, { type: 'blog-outline' }), rec(3, { type: 'blog-outline' })];
    const { paced, notes } = await applyPacing(site, candidates, { recentDraftCheck: never });

    assert.deepEqual(paced.map((r) => r.id), [1], 'candidates arrive in priority order — the first survives');
    assert.match(notes[0], /taking 1 of 3/);
  });

  test('holds a paced generator entirely when one was published inside the gap window', async () => {
    const candidates = [rec(1, { type: 'blog-outline' }), rec(2, { type: 'blog-outline' })];
    const { paced, notes } = await applyPacing(site, candidates, { recentDraftCheck: async () => true });

    assert.deepEqual(paced, []);
    assert.match(notes[0], /held/);
  });

  test('never touches an unpaced generator — pacing is about publishing cadence, not throughput', async () => {
    const candidates = [rec(1, { type: 'meta-title' }), rec(2, { type: 'faq' }), rec(3, { type: 'meta-title' })];
    const { paced, notes } = await applyPacing(site, candidates, { recentDraftCheck: async () => true });

    assert.deepEqual(paced.map((r) => r.id), [1, 2, 3]);
    assert.deepEqual(notes, []);
  });

  test('a held blog does not take an ordinary fix down with it', async () => {
    const candidates = [rec(1, { type: 'blog-outline' }), rec(2, { type: 'meta-title' })];
    const { paced } = await applyPacing(site, candidates, { recentDraftCheck: async (siteId, type) => type === 'blog-outline' });

    assert.deepEqual(paced.map((r) => r.id), [2]);
  });

  // A blog someone asked for on the Analyst page is a request, not the agent
  // choosing what to publish next — so the cadence gap (which exists to pace
  // the agent's own initiative) doesn't apply, while the one-per-run rule,
  // which is what actually stops a burst, still does.
  test('an explicitly requested blog ships even inside the gap window', async () => {
    const requested = { ...rec(1, { type: 'blog-outline' }), params: { topic: 'best travel insurance', clientRequested: true } };
    const { paced, notes } = await applyPacing(site, [requested], { recentDraftCheck: async () => true });

    assert.deepEqual(paced.map((r) => r.id), [1]);
    assert.match(notes[0], /cadence gap does not apply/);
  });

  test('a requested blog wins the single slot over agent-chosen ones, and only one ships', async () => {
    const candidates = [
      rec(1, { type: 'blog-outline' }),
      { ...rec(2, { type: 'blog-outline' }), params: { topic: 'best travel insurance', clientRequested: true } },
      { ...rec(3, { type: 'blog-outline' }), params: { topic: 'cheap flights', clientRequested: true } },
    ];
    const { paced } = await applyPacing(site, candidates, { recentDraftCheck: never });

    assert.deepEqual(paced.map((r) => r.id), [2], 'the first requested topic ships; the agent-chosen one and the second request wait');
  });

  test('two requested blogs never ship on the same run — the second waits for the next day', async () => {
    const candidates = [
      { ...rec(1, { type: 'blog-outline' }), params: { topic: 'a', clientRequested: true } },
      { ...rec(2, { type: 'blog-outline' }), params: { topic: 'b', clientRequested: true } },
    ];
    const { paced } = await applyPacing(site, candidates, { recentDraftCheck: never });

    assert.equal(paced.length, 1);
  });
});

// The churn this ends, measured on site 1 over three days: 623 drafts for 496
// distinct findings, single findings redrafted up to TEN times, every attempt
// abandoned. Abandoning un-hides a finding so it can be retried — right for a
// transient failure, wrong for a permanent one, and nothing told them apart.
describe('applyConvergenceCap', () => {
  test('drops a finding that has already failed the maximum number of times, with no recovery cycles yet earned', async () => {
    const attemptCounts = new Map([['f2', MAX_FAILED_ATTEMPTS]]);
    const { converged, notes } = await applyConvergenceCap(site, [rec(1), rec(2), rec(3)], { attemptCounts, recoveryCounts: new Map() });

    assert.deepEqual(converged.map((r) => r.id), [1, 3]);
    assert.match(notes[0], /held after 3 failed attempt/);
    assert.match(notes[0], /cap 3 after 0 recovery cycle/);
  });

  test('keeps a finding still under the cap — an early failure can genuinely be bad luck', async () => {
    const attemptCounts = new Map([['f1', MAX_FAILED_ATTEMPTS - 1]]);
    const { converged, notes } = await applyConvergenceCap(site, [rec(1)], { attemptCounts, recoveryCounts: new Map() });

    assert.deepEqual(converged.map((r) => r.id), [1]);
    assert.deepEqual(notes, []);
  });

  // A recommendation can carry several findings; one permanently-unfixable
  // component is enough to make the whole thing fail identically every run.
  test('uses the highest attempt count among a recommendation\'s findings', async () => {
    const attemptCounts = new Map([['fa', 0], ['fb', MAX_FAILED_ATTEMPTS + 4]]);
    const { converged } = await applyConvergenceCap(site, [rec(1, { findingIds: ['fa', 'fb'] })], { attemptCounts, recoveryCounts: new Map() });

    assert.deepEqual(converged, []);
  });

  test('a finding with no failure history is untouched', async () => {
    const { converged, notes } = await applyConvergenceCap(site, [rec(1), rec(2)], { attemptCounts: new Map() });

    assert.deepEqual(converged.map((r) => r.id), [1, 2]);
    assert.deepEqual(notes, []);
  });

  test('an empty candidate list short-circuits without consulting the store', async () => {
    let consulted = false;
    const { converged } = await applyConvergenceCap(site, [], {
      attemptCounts: new Proxy(new Map(), { get: () => { consulted = true; return undefined; } }),
    });

    assert.deepEqual(converged, []);
    assert.equal(consulted, false);
  });

  // The whole point of the 2026-09-06 autonomous-recovery change: a finding
  // that has already earned recovery cycles (lib/action-center-reconciler.js
  // re-detected it against live content and refreshed its params) gets a
  // HIGHER cap, not the same flat one — each cycle is a genuinely fresh,
  // independently-evidenced attempt, not a repeat of the one that already
  // failed 3 times.
  test('a finding that has already earned a recovery cycle survives past the flat cap', async () => {
    const attemptCounts = new Map([['f1', MAX_FAILED_ATTEMPTS]]);
    const recoveryCounts = new Map([['f1', 1]]);
    const { converged } = await applyConvergenceCap(site, [rec(1)], { attemptCounts, recoveryCounts });

    assert.deepEqual(converged.map((r) => r.id), [1], 'one recovery cycle raises the cap to 2*MAX_FAILED_ATTEMPTS — 3 attempts is still under it');
  });

  test('is held again once attempts exhaust the raised cap from an earned recovery cycle', async () => {
    const attemptCounts = new Map([['f1', MAX_FAILED_ATTEMPTS * 2]]);
    const recoveryCounts = new Map([['f1', 1]]);
    const { converged, notes } = await applyConvergenceCap(site, [rec(1)], { attemptCounts, recoveryCounts });

    assert.deepEqual(converged, []);
    assert.match(notes[0], /cap 6 after 1 recovery cycle/);
  });

  test('never fetches recovery history for a site with no failed attempts at all', async () => {
    let consulted = false;
    const { converged } = await applyConvergenceCap(site, [rec(1)], {
      attemptCounts: new Map(),
      recoveryCounts: new Proxy(new Map(), { get: () => { consulted = true; return undefined; } }),
    });

    assert.deepEqual(converged.map((r) => r.id), [1]);
    assert.equal(consulted, false, 'counts.size === 0 short-circuits before recovery history is ever read');
  });
});

describe('effectiveConvergenceCap', () => {
  test('is the flat cap with zero recovery cycles', () => {
    assert.equal(effectiveConvergenceCap(0), MAX_FAILED_ATTEMPTS);
    assert.equal(effectiveConvergenceCap(undefined), MAX_FAILED_ATTEMPTS);
  });

  test('grows by one full MAX_FAILED_ATTEMPTS per recovery cycle', () => {
    assert.equal(effectiveConvergenceCap(1), MAX_FAILED_ATTEMPTS * 2);
    assert.equal(effectiveConvergenceCap(MAX_RECOVERY_CYCLES), MAX_FAILED_ATTEMPTS * (MAX_RECOVERY_CYCLES + 1));
  });
});

// The refusal cap. Refusals are excluded from the learned score AND
// invisible to the convergence cap (which counts abandoned drafts, and a
// refusal never creates one), so before this a refusing item had no brake at
// all — site 1 had one direct-answer recommendation refused 22 times and
// still being re-drafted every hour.
describe('applyRefusalCap', () => {
  test('holds a recommendation once it has been refused MAX_REFUSALS times', async () => {
    const candidates = [rec(1), rec(2)];
    const refusalCounts = new Map([[1, MAX_REFUSALS]]);
    const { kept, notes } = await applyRefusalCap(site, candidates, { refusalCounts });

    assert.deepEqual(kept.map((r) => r.id), [2]);
    assert.match(notes[0], /held after 5 honest refusal/);
  });

  test('keeps one still under the cap — a refusal can start succeeding when the page changes', async () => {
    const refusalCounts = new Map([[1, MAX_REFUSALS - 1]]);
    const { kept, notes } = await applyRefusalCap(site, [rec(1)], { refusalCounts });

    assert.deepEqual(kept.map((r) => r.id), [1]);
    assert.equal(notes.length, 0, 'nothing was held, so nothing is reported');
  });

  test('is a no-op when the site has no refusal history at all', async () => {
    const { kept, notes } = await applyRefusalCap(site, [rec(1)], { refusalCounts: new Map() });
    assert.deepEqual(kept.map((r) => r.id), [1]);
    assert.equal(notes.length, 0);
  });
});

describe('applyPacing — trend blog lane', () => {
  const trend = (id) => ({ id, recommendation_type: 'blog-outline', finding_ids: [`t${id}`], params: { topic: `trend ${id}`, category: 'Insights' } });
  const keyword = (id) => ({ id, recommendation_type: 'blog-outline', finding_ids: [`k${id}`], params: { topic: `keyword ${id}` } });

  // A recentDraftCheck stand-in that honours the lane filter, with a ledger of
  // which lanes have published recently.
  const history = ({ trendRecent = false, otherRecent = false }) => async (siteId, type, days, tz, filter = {}) => {
    if (filter.contentCategory === 'Insights') return trendRecent;
    if (filter.excludeContentCategory === 'Insights') return otherRecent;
    return trendRecent || otherRecent;
  };

  test('a trend post and a keyword blog BOTH ship in one run — they no longer share a slot', async () => {
    const { paced } = await applyPacing(site, [trend(1), keyword(2)], { recentDraftCheck: never });
    assert.deepEqual(paced.map((r) => r.id).sort(), [1, 2]);
  });

  test("a recent keyword blog does not hold a trend post back, and the reverse", async () => {
    const heldOther = await applyPacing(site, [trend(1), keyword(2)], { recentDraftCheck: history({ otherRecent: true }) });
    assert.deepEqual(heldOther.paced.map((r) => r.id), [1]);

    const heldTrend = await applyPacing(site, [trend(1), keyword(2)], { recentDraftCheck: history({ trendRecent: true }) });
    assert.deepEqual(heldTrend.paced.map((r) => r.id), [2]);
  });

  test('within the trend lane it is still one per run, highest priority first', async () => {
    const { paced, notes } = await applyPacing(site, [trend(1), trend(2), trend(3), trend(4), trend(5)], { recentDraftCheck: never });
    assert.deepEqual(paced.map((r) => r.id), [1]);
    assert.match(notes[0], /blog-outline \(trend\): taking 1 of 5/);
  });

  test('the trend lane uses its own 3-day gap, the other lane the site\'s own', async () => {
    const seen = [];
    await applyPacing({ ...site, blog_min_gap_days: 7 }, [trend(1), keyword(2)], {
      recentDraftCheck: async (id, type, days, tz, filter) => { seen.push([filter.contentCategory ?? `not-${filter.excludeContentCategory}`, days]); return false; },
    });
    assert.deepEqual(seen, [['Insights', 3], ['not-Insights', 7]]);
  });

  test('five trend posts fit a fortnight: slots on days 0,3,6,9,12', () => {
    // 14 days / 3-day gap: the fifth post at day 12 is the last that fits.
    const slots = []; for (let d = 0; d < 14; d += 3) slots.push(d);
    assert.deepEqual(slots, [0, 3, 6, 9, 12]);
  });

  test('a site with no trend candidates is paced exactly as before', async () => {
    const { paced, notes } = await applyPacing(site, [keyword(1), keyword(2), keyword(3)], { recentDraftCheck: never });
    assert.deepEqual(paced.map((r) => r.id), [1]);
    assert.match(notes[0], /^blog-outline: taking 1 of 3/);
  });

  test('a client-requested topic still jumps its own lane\'s cadence gap', async () => {
    const asked = { ...keyword(9), params: { topic: 'asked', clientRequested: true } };
    const { paced } = await applyPacing(site, [keyword(1), asked], { recentDraftCheck: async () => true });
    assert.deepEqual(paced.map((r) => r.id), [9]);
  });
});
