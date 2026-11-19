import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { cyclePhase, splitHalf, nextBlogDays, isShippableKeyword, shapeForKeyword, followUpFor, orderKeywords } from './keyword-schedule.js';

const start = new Date('2026-10-01T00:00:00Z');
const at = (n) => new Date(start.getTime() + (n - 1) * 86400000); // day n of the programme

describe('which phase a project is in', () => {
  test('days 1-30 only gather', () => {
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: null, now: at(1) }).phase, 'gather');
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: null, now: at(30) }).phase, 'gather');
  });
  test('day 31 ships the first half', () => assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: null, now: at(31) }).phase, 'ship'));
  test('days 31-44 only track, day 45 ships the next half', () => {
    const last = at(31);
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: last, now: at(32) }).phase, 'wait');
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: last, now: at(44) }).phase, 'wait');
    assert.equal(cyclePhase({ growthStartedAt: start, lastCycleAt: last, now: at(45) }).phase, 'ship');
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
    assert.ok(isShippableKeyword({ source: 'internal_analysis', product_relevance: 'direct', observation_count: 2 }));
    assert.ok(!isShippableKeyword({ source: 'internal_analysis', product_relevance: 'direct', observation_count: 1 }));
    assert.ok(!isShippableKeyword({ source: 'internal_analysis', product_relevance: 'none', observation_count: 5 }));
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

describe('the schedule on a real database', { skip }, () => {
  const created = [];
  after(async () => { for (const id of created) await dbm.query('DELETE FROM sites WHERE id = $1', [id]).catch(() => {}); });

  async function makeSite(dayOfProgramme) {
    const d = `ks${crypto.randomBytes(3).toString('hex')}.test`;
    const site = await dbm.createClientSite({ name: `ks-${d}`, websiteDomain: d, timezone: 'UTC', propertyType: 'website' });
    created.push(site.id);
    await dbm.query(`UPDATE sites SET growth_started_at = now() - ($2 || ' days')::interval WHERE id = $1`, [site.id, String(dayOfProgramme - 1)]);
    return (await dbm.query('SELECT * FROM sites WHERE id = $1', [site.id])).rows[0];
  }
  const addGap = (siteId, topic, source = 'internal_analysis') => dbm.query(
    `INSERT INTO keyword_gaps (site_id, topic, reason, priority, status, source, product_relevance, observation_count)
     VALUES ($1,$2,'t','medium','pending_review',$3,'direct',3) RETURNING id`, [siteId, topic, source]).then((r) => r.rows[0].id);

  test('day 20 gathers and ships nothing, but a hand-added keyword is queued the same day', async () => {
    const { runKeywordScheduleForSite } = await import('./keyword-schedule.js');
    const site = await makeSite(20);
    await addGap(site.id, 'found one');
    const mine = await addGap(site.id, 'my own keyword', 'user_request');
    const made = [];
    const create = async (siteId, gap) => { made.push(gap.topic); return { recommendationId: null }; };
    const out = await runKeywordScheduleForSite(site.id, site, { deps: { createRecommendation: create } });
    assert.equal(out.phase, 'gather');
    assert.deepEqual(made, ['my own keyword']);
    assert.ok(mine);
  });

  test('day 31 ships half the found keywords and records the cycle', async () => {
    const { runKeywordScheduleForSite } = await import('./keyword-schedule.js');
    const site = await makeSite(31);
    for (const t of ['a one', 'b two', 'c three', 'd four']) await addGap(site.id, t);
    const made = [];
    const create = async (siteId, gap) => { made.push(gap.topic); return { recommendationId: null }; };
    const out = await runKeywordScheduleForSite(site.id, site, { deps: { createRecommendation: create } });
    assert.equal(out.phase, 'ship');
    assert.equal(made.length, 2);
    const { rows: [s] } = await dbm.query('SELECT keyword_cycle_count FROM sites WHERE id = $1', [site.id]);
    assert.equal(s.keyword_cycle_count, 1);
    const { rows } = await dbm.query(`SELECT count(*)::int AS n FROM keyword_gaps WHERE site_id = $1 AND schedule_batch = 2`, [site.id]);
    assert.equal(rows[0].n, 2, 'the other half is booked for the next cycle');
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
});
