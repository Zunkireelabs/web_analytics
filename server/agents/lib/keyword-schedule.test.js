import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { cyclePhase, splitHalf, splitCycle, evaluateKeyword, nextBlogDays, isShippableKeyword, shapeForKeyword, followUpFor, orderKeywords } from './keyword-schedule.js';

const start = new Date('2026-10-01T00:00:00Z');
const at = (n) => new Date(start.getTime() + (n - 1) * 86400000); // day n of the programme

describe('which phase a project is in (one calendar for every client: gather Saturday, ship the same Sundays)', () => {
  const sun1 = new Date('2026-11-29T05:00:00Z'); // the anchor Sunday
  const day = (n) => new Date(sun1.getTime() + n * 86400000);
  test('every client ships on the anchor Sunday, even one that shipped three days before', () => {
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: null, now: sun1 }).phase, 'ship');
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: new Date('2026-11-26T05:00:00Z'), now: sun1 }).phase, 'ship');
  });
  test('Saturday and weekdays only gather and track', () => {
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: null, now: day(-1) }).phase, 'wait');
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: sun1, now: day(3) }).phase, 'wait');
  });
  test('the next ship Sunday is two weeks later, the Sunday between is tracking', () => {
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: sun1, now: day(7) }).phase, 'wait');
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: sun1, now: day(14) }).phase, 'ship');
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: day(14), now: day(28) }).phase, 'ship');
  });
  test('no project ships twice on one day', () => {
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: new Date('2026-11-29T02:00:00Z'), now: sun1 }).phase, 'wait');
  });
  test('a project that joined off the calendar waits out its 14 days of tracking before the next calendar Sunday ships it again', () => {
    // the calendar ships on day(0), day(14), day(28); this project shipped on day(7) (off-calendar).
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: day(7), now: day(14) }).phase, 'wait', 'only 7 days after its last ship');
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: day(7), now: day(28) }).phase, 'ship', '21 days after, on the calendar');
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: day(7), now: day(14) }).daysToNextShip, 14);
  });
  test('a brand-new project that has never shipped joins the next Sunday, off-calendar too', () => {
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: null, now: day(7) }).phase, 'ship');
  });
  test("the weekday is read in the project's own time zone", () => {
    const lateSat = new Date('2026-11-28T20:00:00Z'); // Sunday 01:45 in Nepal, still Saturday in UTC
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: null, now: lateSat, timezone: 'Asia/Kathmandu' }).phase, 'ship');
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: null, now: lateSat, timezone: 'UTC' }).phase, 'wait');
  });
});

describe('one cycle never floods a client', () => {
  const gaps = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, priority: 'medium', search_volume: i }));
  test('at most KEYWORD_CYCLE_MAX ship, best first; the rest wait', () => {
    const { now, later } = splitCycle(gaps, 10);
    assert.equal(now.length, 10); assert.equal(later.length, 20);
    assert.equal(now[0].id, 30);
  });
});

describe('the day-15 verdict uses measured numbers only', () => {
  test('retain: enough impressions and a click', () => assert.equal(evaluateKeyword({ impressions: 40, clicks: 2, position: 35 }).decision, 'retain'));
  test('retain: enough impressions and a good position, before clicks', () => assert.equal(evaluateKeyword({ impressions: 40, clicks: 0, position: 12 }).decision, 'retain'));
  test('weak first time: improve', () => assert.equal(evaluateKeyword({ impressions: 3, clicks: 0, position: 60, round: 0 }).decision, 'improve'));
  test('plenty of impressions but nowhere near ranking: improve, not retain', () => assert.equal(evaluateKeyword({ impressions: 50, clicks: 0, position: 55 }).decision, 'improve'));
  test('still weak after its fix: replace', () => assert.equal(evaluateKeyword({ impressions: 2, clicks: 0, position: null, round: 1 }).decision, 'replace'));
  test('no Search Console data: never judged', () => {
    assert.equal(evaluateKeyword({ impressions: 0, clicks: 0, position: null, round: 1, hasData: false }).decision, 'pending');
  });
});

describe('splitting the gathered keywords', () => {
  const gaps = [1, 2, 3, 4, 5].map((id) => ({ id, priority: id === 5 ? 'high' : 'medium', search_volume: id * 10 }));
  test('half ship now (the better half), the rest wait a cycle', () => {
    const { now, later } = splitHalf(gaps);
    assert.deepEqual(now.map((g) => g.id), [5, 4, 3]);
    assert.deepEqual(later.map((g) => g.id), [2, 1]);
  });
  test('one keyword ships rather than waiting forever', () => assert.equal(splitHalf([{ id: 1 }]).now.length, 1));
  test('order is stable', () => assert.deepEqual(orderKeywords([{ id: 2 }, { id: 1 }]).map((g) => g.id), [1, 2]));
});

describe('blog days follow the project gap', () => {
  test('first blog today, then every 3 days', () => assert.deepEqual(nextBlogDays(3, { today: '2026-11-18' }), ['2026-11-18', '2026-11-21', '2026-11-24']));
  test('counts from the last blog, not from today', () => assert.deepEqual(nextBlogDays(2, { today: '2026-11-18', lastBlogDay: '2026-11-17' }), ['2026-11-20', '2026-11-23']));
  test('a last blog long ago does not book the past', () => assert.equal(nextBlogDays(1, { today: '2026-11-18', lastBlogDay: '2026-10-01' })[0], '2026-11-18'));
  test('a keyword added 4 days early still takes the next free day', () => {
    // last blog was booked for the 20th; the keyword was added on the 16th, the day it gets is the 23rd.
    assert.equal(nextBlogDays(1, { today: '2026-11-16', lastBlogDay: '2026-11-20' })[0], '2026-11-23');
  });
  test('respects a different gap', () => assert.deepEqual(nextBlogDays(2, { today: '2026-11-18', gapDays: 5 }), ['2026-11-18', '2026-11-23']));
});

describe('what may ship', () => {
  test('hand-added and trend keywords always may', () => {
    assert.ok(isShippableKeyword({ source: 'user_request' }));
    assert.ok(isShippableKeyword({ source: 'trend_radar' }));
  });
  test('a found keyword needs relevance and a second sighting', () => {
    assert.ok(isShippableKeyword({ source: 'claude_research', product_relevance: 'direct', coverage_status: 'opportunity', observation_count: 1 }));
    assert.ok(isShippableKeyword({ source: 'claude_research', product_relevance: 'supporting', coverage_status: 'market_gap' }));
    assert.ok(!isShippableKeyword({ source: 'claude_research', product_relevance: 'direct', coverage_status: 'covered' }));
    assert.ok(!isShippableKeyword({ source: 'claude_research', product_relevance: 'direct', coverage_status: 'duplicate' }));
    assert.ok(!isShippableKeyword({ source: 'claude_research', product_relevance: 'unrelated', coverage_status: 'opportunity' }));
    assert.ok(!isShippableKeyword({ source: 'internal_analysis', product_relevance: 'none', coverage_status: 'opportunity' }));
  });
  test('three ways to ship, landing pages never', () => {
    assert.equal(shapeForKeyword({ generatorId: 'blog-outline' }), 'new_blog');
    assert.equal(shapeForKeyword({ generatorId: 'expand-content' }), 'existing_page');
    assert.equal(shapeForKeyword({ generatorId: 'faq' }), 'faq');
    assert.equal(shapeForKeyword({ generatorId: 'landing-page' }), null);
    assert.equal(shapeForKeyword({ generatorId: 'blog-outline', requiresFutureInfrastructure: true }), null);
  });
});

describe('the follow-up for weak keywords', () => {
  test('enough impressions: nothing to do', () => assert.equal(followUpFor({ impressions: 40, targetPage: '/a' }).action, 'none'));
  test('few impressions: link to its page', () => {
    const f = followUpFor({ impressions: 3, targetPage: '/a' });
    assert.deepEqual([f.action, f.page], ['internal-links', '/a']);
  });
  test('no page at all: a note to check indexing', () => assert.equal(followUpFor({ impressions: 0 }).action, 'note'));
});

// ── real local Postgres ──
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
const isLocal = (() => { try { return ['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname); } catch { return false; } })();
const dbm = await import('../../db.js');
let skip = isLocal ? false : 'not a local database';
if (!skip) { try { await dbm.query('SELECT schedule_batch FROM keyword_gaps LIMIT 1'); } catch (e) { skip = `no local database (${e.code || e.message})`; } }

// The real planner looks keywords up on Google's results page (a paid, budgeted call), so every schedule test that is not ABOUT merging
// hands it this stand-in. A test must never reach the real one from a developer machine that has DataForSEO credentials in .env.
const NO_MERGE = { serpMergeEnabled: () => false, planSerpMerges: async () => ({ merges: [] }) };

describe('the schedule on a real database', { skip }, () => {
  const created = [];
  // recommendations do not cascade from sites, so they go first; a swallowed foreign-key error here used to leave one test site behind per run
  after(async () => { for (const id of created) { await dbm.query('DELETE FROM recommendations WHERE site_id = $1', [id]).catch(() => {}); await dbm.query('DELETE FROM sites WHERE id = $1', [id]).catch(() => {}); } });

  async function makeSite(dayOfProgramme) {
    const d = `ks${crypto.randomBytes(3).toString('hex')}.test`;
    const site = await dbm.createClientSite({ name: `ks-${d}`, websiteDomain: d, timezone: 'UTC', propertyType: 'website' });
    created.push(site.id);
    await dbm.query(`UPDATE sites SET growth_started_at = now() - ($2 || ' days')::interval WHERE id = $1`, [site.id, String(dayOfProgramme - 1)]);
    return (await dbm.query('SELECT * FROM sites WHERE id = $1', [site.id])).rows[0];
  }
  const addGap = (siteId, topic, source = 'internal_analysis') => dbm.query(
    `INSERT INTO keyword_gaps (site_id, topic, reason, priority, status, source, product_relevance, observation_count, coverage_status)
     VALUES ($1,$2,'t','medium','pending_review',$3,'direct',1,'opportunity') RETURNING id`, [siteId, topic, source]).then((r) => r.rows[0].id);

  test('day 20 ships at once (no 30-day gather): the qualified keyword and the hand-added one are both queued', async () => {
    const { runKeywordScheduleForSite } = await import('./keyword-schedule.js');
    const site = await makeSite(20);
    await addGap(site.id, 'found one');
    await addGap(site.id, 'covered already');
    await dbm.query(`UPDATE keyword_gaps SET coverage_status = 'covered' WHERE site_id = $1 AND topic = 'covered already'`, [site.id]);
    await addGap(site.id, 'my own keyword', 'user_request');
    const made = [];
    const create = async (siteId, gap) => { made.push(gap.topic); return { recommendationId: null }; };
    const out = await runKeywordScheduleForSite(site.id, site, { deps: { createRecommendation: create, serpMerge: NO_MERGE } });
    assert.equal(out.phase, 'ship');
    assert.deepEqual([...made].sort(), ['found one', 'my own keyword'], 'a keyword the coverage check says is already covered is not shipped');
  });

  test('the first cycle ships the qualified keywords up to the cap and records the cycle; the rest wait one cycle', async () => {
    const { runKeywordScheduleForSite } = await import('./keyword-schedule.js');
    const site = await makeSite(31);
    for (let i = 0; i < 14; i++) await addGap(site.id, `kw ${String(i).padStart(2, '0')}`);
    const made = [];
    const create = async (siteId, gap) => { made.push(gap.topic); return { recommendationId: null }; };
    const out = await runKeywordScheduleForSite(site.id, site, { deps: { createRecommendation: create, serpMerge: NO_MERGE } });
    assert.equal(out.phase, 'ship');
    assert.equal(made.length, 10, 'KEYWORD_CYCLE_MAX (10) ship, not half of everything');
    const { rows: [s] } = await dbm.query('SELECT keyword_cycle_count FROM sites WHERE id = $1', [site.id]);
    assert.equal(s.keyword_cycle_count, 1);
    const { rows } = await dbm.query(`SELECT count(*)::int AS n FROM keyword_gaps WHERE site_id = $1 AND schedule_batch = 2`, [site.id]);
    assert.equal(rows[0].n, 4, 'the other four are booked for the next cycle');
    const again = await runKeywordScheduleForSite(site.id, { ...site, keyword_cycle_count: 1, keyword_cycle_last_at: new Date() }, { deps: { createRecommendation: create, serpMerge: NO_MERGE } });
    assert.equal(again.phase, 'wait', 'the next cycle is 15 days later, not tomorrow');
  });

  test('open blogs get days 3 apart, at most five ahead, hand-added first', async () => {
    const { assignBlogSlots } = await import('./keyword-schedule.js');
    const { insertRecommendation } = await import('../../store/recommendations.js');
    const site = await makeSite(40);
    for (let i = 0; i < 7; i++) {
      await insertRecommendation(site.id, {
        page: `blog:${i}`, recommendationType: 'blog-outline', issue: `post ${i}`, reason: 'r', params: i === 6 ? { topic: `post ${i}`, clientRequested: true } : { topic: `post ${i}` },
        findingId: `ks-test:${site.id}:${i}`, detectingAgent: 'keyword-schedule', priority: 'medium', riskTier: 'safe',
      });
    }
    const now = new Date('2026-11-18T09:00:00Z');
    const out = await assignBlogSlots(site.id, site, { now });
    assert.equal(out.booked, 5);
    assert.deepEqual(out.days, ['2026-11-18', '2026-11-21', '2026-11-24', '2026-11-27', '2026-11-30']);
    const { rows: [first] } = await dbm.query(`SELECT params FROM recommendations WHERE site_id = $1 AND params->>'scheduledFor' = '2026-11-18'`, [site.id]);
    assert.equal(first.params.clientRequested, true);
    assert.equal((await assignBlogSlots(site.id, site, { now })).booked, 0, 'running again books nothing more');
  });

  describe('keywords that Google treats as the same search', () => {
    const merge = (merges) => ({ serpMergeEnabled: () => true, planSerpMerges: async () => ({ merges }) });
    const planFor = (site, ids) => ids.map((id) => ({ keywordId: id, topic: `t${id}`, intoId: 0, intoTopic: 'primary', shared: 8, note: `Merged into "primary": 8 of 10 pages are the same` }));

    test('a folded keyword is not queued; it is dismissed with a note saying where it went, and the rest are queued', async () => {
      const { runKeywordScheduleForSite } = await import('./keyword-schedule.js');
      const site = await makeSite(31);
      const ids = []; for (const t of ['a one', 'b two', 'c three', 'd four']) ids.push(await addGap(site.id, t));
      const made = [];
      const create = async (siteId, gap) => { made.push(gap.topic); return { recommendationId: null }; };
      // fold whichever keyword is shipped first into the other(s): ask for the first two ids to be folded
      let folded;
      const serpMerge = { serpMergeEnabled: () => true, planSerpMerges: async ({ keywords }) => { folded = keywords[0]; return { merges: [{ keywordId: folded.id, topic: folded.topic, intoId: keywords[1].id, intoTopic: keywords[1].topic, shared: 9, note: `Merged into "${keywords[1].topic}": 9 of 10 pages are the same` }] }; } };
      const out = await runKeywordScheduleForSite(site.id, site, { deps: { createRecommendation: create, serpMerge } });
      assert.equal(out.merged, 1);
      assert.ok(!made.includes(folded.topic), 'the folded keyword was not queued');
      assert.equal(made.length, 3, 'all 4 qualify and ship (under the cap of 10); one of them was folded away');
      const { rows: [g] } = await dbm.query('SELECT status, followup_note FROM keyword_gaps WHERE id = $1', [folded.id]);
      assert.equal(g.status, 'dismissed');
      assert.match(g.followup_note, /^Merged into ".+": 9 of 10 pages are the same/);
      assert.ok(ids.length === 4);
    });

    test('with the merge switched off, or when the planner fails, everything is queued exactly as before', async () => {
      const { runKeywordScheduleForSite } = await import('./keyword-schedule.js');
      for (const serpMerge of [{ serpMergeEnabled: () => false, planSerpMerges: async () => { throw new Error('must not be called'); } }, { serpMergeEnabled: () => true, planSerpMerges: async () => { throw new Error('serp down'); } }]) {
        const site = await makeSite(31);
        for (const t of ['a one', 'b two', 'c three', 'd four']) await addGap(site.id, t);
        const made = [];
        const create = async (siteId, gap) => { made.push(gap.topic); return { recommendationId: null }; };
        const out = await runKeywordScheduleForSite(site.id, site, { deps: { createRecommendation: create, serpMerge } });
        assert.equal(made.length, 4); assert.equal(out.merged, 0);
        const { rows } = await dbm.query(`SELECT count(*)::int AS n FROM keyword_gaps WHERE site_id = $1 AND status = 'dismissed'`, [site.id]);
        assert.equal(rows[0].n, 0);
      }
    });

    test('a dry run changes nothing and makes no lookups', async () => {
      const { runKeywordScheduleForSite } = await import('./keyword-schedule.js');
      const site = await makeSite(31);
      for (const t of ['a one', 'b two', 'c three', 'd four']) await addGap(site.id, t);
      const out = await runKeywordScheduleForSite(site.id, site, { dryRun: true, deps: { serpMerge: { serpMergeEnabled: () => true, planSerpMerges: async () => { throw new Error('a dry run must not look anything up'); } } } });
      assert.equal(out.merged, 0);
    });
  });

});

describe('a bad timezone value', () => {
  test('is read as UTC instead of stopping the schedule run', () => {
    const sun = new Date('2026-11-29T05:00:00Z');
    assert.doesNotThrow(() => cyclePhase({ growthStartedAt: new Date('2026-11-01T00:00:00Z'), lastCycleAt: null, now: sun, timezone: 'Not/AZone' }));
    assert.equal(cyclePhase({ growthStartedAt: new Date('2026-11-01T00:00:00Z'), lastCycleAt: null, now: sun, timezone: 'Not/AZone' }).phase, 'ship');
  });
});
