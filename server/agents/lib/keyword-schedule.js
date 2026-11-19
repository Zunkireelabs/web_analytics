import { growthStageFor, ACCELERATION_DAYS } from '../../lib/growth-stage.js';

// THE KEYWORD SCHEDULE (owner's plan, 2026-11-18). One queue and one calendar per project, run by the daily cron
// (job.js runKeywordScheduleForAllSites), following the project's growth clock (sites.growth_started_at):
//
//   days 1-30   GATHER: keywords are collected and nothing new is published (ranking pages keep getting their ordinary fixes).
//   day 31      SHIP the first half of what was gathered. A keyword an existing page covers is added to that page; one that
//               needs a page becomes a blog, given a day 3 apart (the project's blog gap).
//   days 31-44  TRACK: each shipped keyword's impressions are counted over the 14 days after it went live.
//   day 45      SHIP the second half (plus half of anything gathered since), and give the first half's weak keywords a fix.
//   then        every 14 days the same.
//
// Keywords added by hand, and trend-radar topics, join the same queue and take the project's next free blog day.
// Everything here is a recommendation in Action Center; auto-remediation drafts and opens the PR on or after its day, and a
// person still merges it.

export const CYCLE_DAYS = 14;
export const BLOG_GAP_DEFAULT_DAYS = 3;
export const LOW_IMPRESSIONS = 10; // fewer than this in the 14 days after shipping = needs a follow-up fix
export const TRACK_DAYS = 14;

const MS_DAY = 86400000;
const dayOnly = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (iso, n) => dayOnly(new Date(`${iso}T00:00:00Z`).getTime() + n * MS_DAY);

/**
 * Pure. What today is for this project.
 *   gather  day <= 30
 *   ship    day >= 31 and no cycle has run yet, or the last one was CYCLE_DAYS or more ago
 *   wait    between cycles (the 14 days of tracking)
 */
export function cyclePhase({ growthStartedAt, lastCycleAt, now = new Date() }) {
  const g = growthStageFor(growthStartedAt, now);
  if (g.day <= ACCELERATION_DAYS) return { phase: 'gather', day: g.day, daysToFirstShip: ACCELERATION_DAYS + 1 - g.day };
  const since = lastCycleAt ? Math.floor((now.getTime() - new Date(lastCycleAt).getTime()) / MS_DAY) : Infinity;
  return since >= CYCLE_DAYS ? { phase: 'ship', day: g.day } : { phase: 'wait', day: g.day, daysToNextShip: CYCLE_DAYS - since };
}

/** Pure. Best first (priority, then search volume), then the first ceil(n/2) ship now and the rest are next cycle's. */
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
export function orderKeywords(gaps) {
  return [...gaps].sort((a, b) =>
    (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) ||
    Number(b.search_volume ?? -1) - Number(a.search_volume ?? -1) ||
    Number(a.id) - Number(b.id));
}
export function splitHalf(gaps) {
  const ordered = orderKeywords(gaps);
  const cut = Math.ceil(ordered.length / 2);
  return { now: ordered.slice(0, cut), later: ordered.slice(cut) };
}

/**
 * Pure. The next `count` free blog days, GAP days apart. A day is free when no blog was published or already booked
 * within GAP days of it. `lastBlogDay` is the latest published OR booked blog day (any source: keyword, trend, manual).
 */
export function nextBlogDays(count, { today, lastBlogDay = null, gapDays = BLOG_GAP_DEFAULT_DAYS }) {
  const gap = Math.max(1, Number(gapDays) || BLOG_GAP_DEFAULT_DAYS);
  const days = [];
  let day = lastBlogDay ? addDays(lastBlogDay, gap) : today;
  if (day < today) day = today;
  for (let i = 0; i < count; i++) { days.push(day); day = addDays(day, gap); }
  return days;
}

/** Pure. A keyword the schedule may publish: relevant to the business, seen more than once (unless a person or the trend radar chose it). */
export const CHOSEN_SOURCES = new Set(['user_request', 'trend_radar']);
export function isShippableKeyword(gap) {
  if (CHOSEN_SOURCES.has(gap.source)) return true;
  return ['direct', 'supporting'].includes(gap.product_relevance) && Number(gap.observation_count || 1) >= 2;
}

/** Pure. Which of the three ways a keyword ships (null = not shippable by the schedule, stays in the queue). */
export function shapeForKeyword(eligibility) {
  if (!eligibility || eligibility.requiresFutureInfrastructure) return null;
  if (eligibility.generatorId === 'blog-outline') return 'new_blog';
  if (eligibility.generatorId === 'faq') return 'faq';
  if (eligibility.generatorId === 'expand-content') return 'existing_page';
  return null; // landing pages are a bigger commitment: never scheduled, always a person's call (see qualifyAndShipContentGaps)
}

/** Pure. Did a shipped keyword get enough impressions, and what does the follow-up look like. */
export function followUpFor({ shipMode, impressions, topPage, targetPage }) {
  if (impressions >= LOW_IMPRESSIONS) return { action: 'none', note: null };
  const page = targetPage || topPage;
  if (!page) return { action: 'note', note: `Only ${impressions} impression(s) in ${TRACK_DAYS} days and no page of ours has been shown for it yet: check the page is indexed.` };
  return { action: 'internal-links', page, note: `Only ${impressions} impression(s) in ${TRACK_DAYS} days: queued a link to it from a page that already earns clicks.` };
}

// ───────────────────────── database side (loaded on first use, so the pure parts above stay importable anywhere) ─────────────────────────
const db = () => import('../../db.js').then((m) => m.query);

export const MAX_BOOKED_AHEAD = 5; // blog days booked at once (about two weeks at a 3-day gap)
const todayIn = (tz, now) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

async function lastBlogDay(query, siteId, tz) {
  const { rows } = await query(
    `SELECT GREATEST(
        (SELECT max((created_at AT TIME ZONE $2)::date) FROM drafts WHERE site_id = $1 AND action_type = 'blog-outline' AND status <> 'abandoned'),
        (SELECT max((params->>'scheduledFor')::date) FROM recommendations WHERE site_id = $1 AND recommendation_type = 'blog-outline' AND status = 'open')
     )::text AS d`, [siteId, tz || 'UTC']);
  return rows[0]?.d || null;
}

/**
 * Gives every open blog (keyword, trend-radar or hand-added) its day, one per gap, in this order: hand-added first, then
 * trend posts, then the rest. Writes params.scheduledFor; the shipping loop holds a blog until that day (ship-pacing.js).
 * Books at most MAX_BOOKED_AHEAD days ahead so a deep backlog is not given dates months away.
 */
export async function assignBlogSlots(siteId, site, { now = new Date() } = {}) {
  const query = await db();
  const tz = site?.timezone || 'UTC';
  const gapDays = site?.blog_min_gap_days ?? BLOG_GAP_DEFAULT_DAYS;
  const { rows: open } = await query(
    `SELECT id, params, created_at FROM recommendations
      WHERE site_id = $1 AND recommendation_type = 'blog-outline' AND status = 'open' AND params->>'scheduledFor' IS NULL
      ORDER BY created_at, id`, [siteId]);
  if (!open.length) return { booked: 0 };
  const { rows: [{ n }] } = await query(
    `SELECT count(*)::int AS n FROM recommendations WHERE site_id = $1 AND recommendation_type = 'blog-outline' AND status = 'open'
        AND params->>'scheduledFor' IS NOT NULL AND (params->>'scheduledFor')::date >= $2::date`, [siteId, todayIn(tz, now)]);
  const room = Math.max(0, MAX_BOOKED_AHEAD - n);
  const rank = (r) => (r.params?.clientRequested ? 0 : r.params?.category === 'Insights' ? 1 : 2);
  const chosen = [...open].sort((a, b) => rank(a) - rank(b)).slice(0, room);
  if (!chosen.length) return { booked: 0 };
  const days = nextBlogDays(chosen.length, { today: todayIn(tz, now), lastBlogDay: await lastBlogDay(query, siteId, tz), gapDays });
  for (const [i, r] of chosen.entries()) {
    await query(`UPDATE recommendations SET params = params || jsonb_build_object('scheduledFor', $2::text) WHERE id = $1 AND site_id = $3`, [r.id, days[i], siteId]);
    await query(`UPDATE keyword_gaps SET scheduled_for = $2 WHERE site_id = $1 AND recommendation_id = $3`, [siteId, days[i], r.id]);
  }
  return { booked: chosen.length, days };
}

/**
 * One project, one day. Always books blog days; on a ship day also queues this cycle's keywords. Never drafts or opens a PR
 * itself: it creates the Action Center items, and the daily shipping run does the rest on the day each one is due.
 */
export async function runKeywordScheduleForSite(siteId, site, { now = new Date(), dryRun = false, deps = {} } = {}) {
  const query = await db();
  const s = site || (await import('../../store/read.js')).getSiteById && await (await import('../../store/read.js')).getSiteById(siteId);
  const { getKeywordGaps, updateKeywordGapStatus } = await import('../../store/data-analyst.js');
  const { createActionCenterRecommendationForGap } = await import('./analyst-seo-mapping.js');
  const create = deps.createRecommendation || createActionCenterRecommendationForGap;
  const phase = cyclePhase({ growthStartedAt: s.growth_started_at, lastCycleAt: s.keyword_cycle_last_at, now });
  const out = { siteId, ...phase, queued: 0, carried: 0, deferred: 0, booked: 0 };

  const queueOne = async (g, cycle) => {
    try {
      const updated = await updateKeywordGapStatus(siteId, g.id, 'approved');
      const r = await create(siteId, { ...g, ...(updated || {}), _scheduled: true }, { deferDraft: true });
      if (!r?.recommendationId) {
        // Not shippable by the schedule (a landing page, a comparison, a designed page): back to the queue for a person.
        await updateKeywordGapStatus(siteId, g.id, 'pending_review'); out.deferred++;
        return;
      }
      const { rows: [rec] } = await query(`SELECT recommendation_type, params FROM recommendations WHERE id = $1`, [r.recommendationId]);
      const mode = shapeForKeyword({ generatorId: rec?.recommendation_type });
      await query(`UPDATE keyword_gaps SET schedule_batch = $3, ship_mode = $4, target_page = $5, recommendation_id = $6 WHERE site_id = $1 AND id = $2`,
        [siteId, g.id, cycle, mode, rec?.params?.page || null, r.recommendationId]);
      out.queued++;
    } catch (err) {
      console.error(`[keyword-schedule] site ${siteId} keyword "${g.topic}":`, err.message);
    }
  };

  if (phase.phase === 'ship') {
    const cycle = Number(s.keyword_cycle_count || 0) + 1;
    const gaps = (await getKeywordGaps(siteId, 'pending_review')).filter(isShippableKeyword);
    const { rows: assigned } = await query(`SELECT id, schedule_batch FROM keyword_gaps WHERE site_id = $1 AND status = 'pending_review' AND schedule_batch IS NOT NULL`, [siteId]);
    const batchOf = new Map(assigned.map((r) => [r.id, r.schedule_batch]));
    const carry = gaps.filter((g) => batchOf.has(g.id) && batchOf.get(g.id) <= cycle);
    const fresh = gaps.filter((g) => !batchOf.has(g.id));
    const chosenByPerson = fresh.filter((g) => CHOSEN_SOURCES.has(g.source));
    const { now: firstHalf, later } = splitHalf(fresh.filter((g) => !CHOSEN_SOURCES.has(g.source)));
    const toShip = [...carry, ...chosenByPerson, ...firstHalf];
    out.carried = carry.length; out.deferred = later.length;
    if (!dryRun) {
      for (const g of later) await query(`UPDATE keyword_gaps SET schedule_batch = $3 WHERE site_id = $1 AND id = $2`, [siteId, g.id, cycle + 1]);
      for (const g of toShip) await queueOne(g, cycle);
      await query(`UPDATE sites SET keyword_cycle_count = $2, keyword_cycle_last_at = $3 WHERE id = $1`, [siteId, cycle, now]);
    } else out.queued = toShip.length;
  }

  // Keywords a person typed in (or trend-radar topics) never wait for a ship day: any day they are queued, and the blog lane
  // gives each one its day, so one added four days early still ships on the next blog day.
  if (!dryRun && phase.phase !== 'ship') {
    const chosen = (await getKeywordGaps(siteId, 'pending_review')).filter((g) => isShippableKeyword(g) && CHOSEN_SOURCES.has(g.source) && !g.recommendation_id);
    for (const g of chosen) await queueOne(g, Number(s.keyword_cycle_count || 0));
  }

  if (!dryRun) out.booked = (await assignBlogSlots(siteId, s, { now })).booked;
  return out;
}

/**
 * Counts each shipped keyword's impressions over the TRACK_DAYS after it went live, and queues a link to its page when it is
 * weak. Reads gsc_query_page only; nothing here calls a model.
 */
export async function measureKeywordImpressions(siteId, { now = new Date() } = {}) {
  const query = await db();
  // When did it go live: the merge of the draft made for its recommendation.
  await query(
    `UPDATE keyword_gaps g SET shipped_at = d.at
       FROM (SELECT r.id AS rid, min(dr.implemented_at) AS at FROM recommendations r
               JOIN drafts dr ON dr.site_id = r.site_id AND dr.finding_id = ANY(r.finding_ids) AND dr.status = 'implemented'
              WHERE r.site_id = $1 GROUP BY r.id) d
      WHERE g.site_id = $1 AND g.recommendation_id = d.rid AND g.shipped_at IS NULL AND d.at IS NOT NULL`, [siteId]);
  const { rows: due } = await query(
    `SELECT id, topic, ship_mode, target_page, shipped_at FROM keyword_gaps
      WHERE site_id = $1 AND shipped_at IS NOT NULL AND impressions_measured_at IS NULL AND shipped_at <= $2::timestamptz - ($3 || ' days')::interval`,
    [siteId, now, String(TRACK_DAYS)]);
  const out = { measured: 0, weak: 0, followUps: 0 };
  if (!due.length) return out;
  const { pickLinkSource } = await import('./zero-impression-pages.js');
  const { insertRecommendation } = await import('../../store/recommendations.js');
  const since = new Date(now.getTime() - 90 * MS_DAY).toISOString().slice(0, 10);
  const { rows: sources } = await query(
    `SELECT page, SUM(clicks)::int AS clicks FROM gsc_query_page WHERE site_id = $1 AND date >= $2 GROUP BY page ORDER BY 2 DESC LIMIT 50`, [siteId, since]);
  const { rows: open } = await query(`SELECT page FROM recommendations WHERE site_id = $1 AND recommendation_type = 'internal-links' AND status = 'open'`, [siteId]);
  const busy = new Set(open.map((r) => r.page));

  for (const g of due) {
    const from = dayOnly(g.shipped_at); const to = addDays(from, TRACK_DAYS);
    const { rows: pages } = await query(
      `SELECT page, SUM(impressions)::int AS impressions FROM gsc_query_page
        WHERE site_id = $1 AND date BETWEEN $2::date AND $3::date AND lower(query) LIKE '%' || lower($4) || '%'
        GROUP BY page ORDER BY 2 DESC`, [siteId, from, to, g.topic]);
    const impressions = pages.reduce((n, p) => n + Number(p.impressions || 0), 0);
    const fu = followUpFor({ shipMode: g.ship_mode, impressions, topPage: pages[0]?.page || null, targetPage: g.target_page });
    let followId = null;
    if (fu.action === 'internal-links') {
      const source = pickLinkSource(fu.page, sources, busy);
      if (source) {
        busy.add(source);
        const rec = await insertRecommendation(siteId, {
          page: source, recommendationType: 'internal-links',
          issue: `Keyword "${g.topic}" got few impressions after it shipped`,
          reason: fu.note, params: { page: source, mustLinkTo: fu.page, measurePage: fu.page },
          findingId: `keyword-schedule:${g.id}:links`, detectingAgent: 'keyword-schedule', priority: 'medium', riskTier: 'safe',
        }).catch((err) => { console.error('[keyword-schedule] follow-up failed:', err.message); return null; });
        followId = rec?.id ?? null; if (followId) out.followUps++;
      }
    }
    await query(`UPDATE keyword_gaps SET impressions_14d = $2, impressions_measured_at = now(), followup_recommendation_id = $3, followup_note = $4 WHERE id = $1`,
      [g.id, impressions, followId, fu.note]);
    out.measured++; if (impressions < LOW_IMPRESSIONS) out.weak++;
  }
  return out;
}
