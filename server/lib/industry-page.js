import { query as dbQuery } from '../db.js';
import { confirmedIndustry } from './industry-detect.js';
import { getIndustrySet } from './industry-sets.js';

// What the client's Industry page shows. Every number here is computed from the project's own tables; a number that cannot be
// computed is left OUT (the page hides its section), never filled with a placeholder. Industry-wide claims are limited to the
// industry set (typical dates, stages) and the shared lesson counts, and both are labelled as such.

const QUESTION = /^(what|how|when|where|why|which|who|can|could|do|does|did|is|are|was|should|will|would)\b|\?$/i;
const MIN_HISTORY_DAYS = 60;      // a trend needs two comparable periods
const ANSWERED_POSITION = 10;     // ranking on page one for the question
const MIN_QUESTIONS = 8;          // a share of 4 questions is noise, not a measurement
// Open recommendations that are about growing in the industry (topics, answers, markets, trust). Technical clean-up (broken links,
// fonts, sitemaps) is real work but it is not an industry move, so it stays on the Action Center and out of this page.
export const GROWTH_AGENTS = ['keyword-narrative', 'growth-queries', 'growth-opportunities', 'ai-recommendation', 'country-intelligence', 'comparison-opportunity', 'query-intelligence', 'trend-radar', 'trust-compliance', 'cta-analysis', 'content-gap', 'geo-signals', 'ai-visibility'];

const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
const monthName = (m) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];

/** Pure. rows: [{ query, impressions, position }] (one per query, impression-weighted position). */
export function summariseQuestions(rows) {
  const qs = rows.filter((r) => QUESTION.test(String(r.query).trim()) && Number(r.impressions) >= 5);
  if (qs.length < MIN_QUESTIONS) return null;
  const answered = qs.filter((r) => Number(r.position) <= ANSWERED_POSITION);
  const open = qs.filter((r) => Number(r.position) > ANSWERED_POSITION).sort((a, b) => b.impressions - a.impressions);
  return {
    total: qs.length,
    answered: answered.length,
    percent: Math.round((answered.length / qs.length) * 100),
    open: open.slice(0, 4).map((r) => ({ question: r.query, shownPerMonth: Math.round(Number(r.impressions) / 3) })),
  };
}

/** Pure. Which of the industry set's dates come next (wrapping the year), nearest first. */
export function upcomingDates(keyDates, now = new Date(), limit = 3) {
  const m = now.getMonth() + 1;
  return [...(keyDates || [])]
    .map((d) => ({ ...d, away: (d.month - m + 12) % 12 }))
    .sort((a, b) => a.away - b.away)
    .slice(0, limit)
    .map((d) => ({ month: monthName(d.month), title: d.title, advice: d.advice }));
}

/** Pure. Four stages in order; the current one is the first not done. Convert is never "done" without visitor data. */
export function stageProgress(stages, { foundDone, trustedDone, convertDone }) {
  const done = [foundDone, trustedDone, convertDone === true, false];
  const current = done.findIndex((d) => !d);
  return stages.map((s, i) => ({ ...s, state: i < current ? 'done' : i === current ? 'now' : 'next' }));
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const short = (t, n) => { const x = String(t || '').replace(/https?:\/\/\S+/gi, 'a page').replace(/\s+/g, ' ').replace(/\s*\(estimated[^)]*\)/i, '').replace(/\(1 impressions\)/g, '(1 impression)').trim(); return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x; };

const quoted = (t) => (String(t || '').match(/"([^"]{3,140})"/) || [])[1] || null;

/** Pure. Client-facing wording for one open recommendation: what to do, then why. Falls back to the recommendation's own text. */
export function plainMove(r) {
  const issue = String(r.issue || '').trim(); const reason = String(r.reason || '').trim();
  const agent = (r.detecting_agents || []).find((a) => GROWTH_AGENTS.includes(a));
  let m;
  if (agent === 'ai-recommendation' && /^cover this topic/i.test(issue) && quoted(reason)) return { title: `Answer this question people ask AI assistants: "${quoted(reason)}"`, reason: 'An assistant answered it without mentioning you.' };
  if (/^duplicate schema/i.test(issue)) return { title: 'Remove duplicated structured data on a page', reason: short(reason, 170) };
  if ((m = issue.match(/^Cover:\s*(.+)$/i))) return { title: `Add a page about ${short(m[1], 70)}`, reason: short(reason, 170) };
  if ((m = issue.match(/^Insight:\s*(.+)$/i))) return { title: `Write about: ${short(m[1], 80)}`, reason: 'It is in the news for your industry right now.' };
  if (agent === 'geo-signals') return { title: 'Add question-and-answer headings to a page, so AI can quote it', reason: 'Pages that ask a clear question and answer it straight away are easier for AI assistants to quote.' };
  if (agent === 'ai-visibility' && /faq/i.test(issue)) return { title: 'Add an FAQ section to a page', reason: 'A short list of real questions and answers helps both visitors and AI assistants.' };
  if (/^generate translation/i.test(issue) && (m = reason.match(/^([A-Z][a-z]+) had/))) return { title: `Translate your top page into ${m[1]}`, reason: short(reason, 170) };
  if (/^generate landing page/i.test(issue) && (m = reason.match(/^(.+?)'s share/))) return { title: `Add a page for visitors from ${m[1]}`, reason: short(reason, 170) };
  if ((m = issue.match(/^Growth opportunity \([^)]*\):\s*"(.+)"$/i))) return { title: `Improve how "${short(m[1], 60)}" shows in search`, reason: short(reason, 170) };
  const generic = /^(cover this topic|generate\b)/i.test(issue);
  return { title: generic && reason ? short(reason, 100) : short(issue, 100), reason: generic ? '' : short(reason, 170) };
}

/** Pure. Up to three growth moves from open recommendations: highest priority first, one per detecting agent before any repeats. */
export function pickMoves(recs) {
  const growth = recs.filter((r) => (r.detecting_agents || []).some((a) => GROWTH_AGENTS.includes(a)))
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3));
  const used = new Set(); const picked = [];
  for (const pass of [0, 1]) {
    for (const r of growth) {
      const agent = (r.detecting_agents || []).find((a) => GROWTH_AGENTS.includes(a));
      if (picked.includes(r) || (pass === 0 && used.has(agent))) continue;
      used.add(agent); picked.push(r);
      if (picked.length === 3) break;
    }
    if (picked.length === 3) break;
  }
  return picked.map((r) => ({ id: r.id, ...plainMove(r), priority: r.priority, from: (r.detecting_agents || []).slice(0, 2) }));
}

export async function buildIndustryPage(siteId, { deps = {}, now = new Date() } = {}) {
  const query = deps.query || dbQuery;
  const ind = await (deps.confirmedIndustry || confirmedIndustry)(siteId, { query });
  if (!ind) return { available: false };

  const set = await getIndustrySet(ind.industry, { query });
  const out = { available: true, industry: ind.industry, label: set?.label || ind.industry, subIndustry: ind.subIndustry, confidence: ind.confidence, source: ind.source, agreeing: ind.agreeing };

  const [pagesQ, qRows, periodQ, recsQ, aiQ, trustQ, clusterQ, radarQ, histQ, postQ] = await Promise.all([
    query('SELECT count(*)::int AS n FROM page_inventory WHERE site_id = $1', [siteId]),
    query(`SELECT query, SUM(impressions)::int AS impressions, (SUM(position * impressions) / NULLIF(SUM(impressions), 0))::float AS position
             FROM gsc_query_page WHERE site_id = $1 AND date >= CURRENT_DATE - 90 GROUP BY query HAVING SUM(impressions) > 0`, [siteId]),
    query(`SELECT COALESCE(SUM(impressions) FILTER (WHERE date >= CURRENT_DATE - 45), 0)::int AS recent,
                  COALESCE(SUM(impressions) FILTER (WHERE date < CURRENT_DATE - 45 AND date >= CURRENT_DATE - 90), 0)::int AS prior,
                  (CURRENT_DATE - MIN(date))::int AS history_days
             FROM gsc_daily WHERE site_id = $1`, [siteId]),
    query(`SELECT id, issue, reason, priority, detecting_agents, page FROM recommendations
            WHERE site_id = $1 AND status = 'open' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_seen_at DESC LIMIT 40`, [siteId]),
    // The latest AI-answer check: every prompt run within 14 days of the most recent run, with its date, so an old check is shown
    // as old ("checked 28 Sep") instead of vanishing.
    query(`WITH last AS (SELECT max(run_date) AS d FROM ai_prompt_runs WHERE site_id = $1)
           SELECT count(*) FILTER (WHERE r.mentioned)::int AS named, count(*)::int AS total, (SELECT d FROM last) AS as_of
             FROM ai_prompt_runs r WHERE r.site_id = $1 AND r.run_date > (SELECT d FROM last) - 14`, [siteId]),
    query(`SELECT count(*)::int AS ran FROM agent_runs WHERE site_id = $1 AND agent_id = 'trust-compliance' AND status = 'ok'`, [siteId]),
    query('SELECT cluster_name, keywords_json, avg_impressions, avg_position FROM keyword_clusters WHERE site_id = $1', [siteId]),
    query(`SELECT facts FROM agent_runs WHERE site_id = $1 AND agent_id = 'trend-radar' AND status = 'ok' ORDER BY created_at DESC LIMIT 1`, [siteId]),
    query(`SELECT query, date, impressions FROM gsc_query_page WHERE site_id = $1 AND date >= CURRENT_DATE - 90`, [siteId]).catch(() => ({ rows: [] })),
    query('SELECT count(*)::int AS n FROM posthog_daily WHERE site_id = $1', [siteId]).catch(() => ({ rows: [{ n: 0 }] })),
  ]);

  const pagesRead = pagesQ.rows[0]?.n || 0;
  const questions = summariseQuestions(qRows.rows);
  const period = periodQ.rows[0] || {};
  const stats = [];
  if (pagesRead) out.pagesRead = pagesRead;
  if (period.prior > 0 && period.history_days >= MIN_HISTORY_DAYS) stats.push({ key: 'demand', label: 'search impressions vs the previous period', value: pct(period.recent, period.prior), unit: 'percent' });
  if (questions) stats.push({ key: 'questions', label: 'of the questions people search are answered', percent: questions.percent, of: questions.total, done: questions.answered });
  const ai = aiQ.rows[0];
  if (ai && ai.total > 0) stats.push({ key: 'ai', label: 'of AI answers name you', percent: Math.round((ai.named / ai.total) * 100), of: ai.total, done: ai.named, asOf: ai.as_of });
  out.stats = stats;
  if (questions) out.questions = questions;

  // moves: the project's own open recommendations, highest priority first, one per page
  out.moves = pickMoves(recsQ.rows);
  const moves = out.moves;

  // stage: computed from checks we can run; anything we cannot measure keeps the stage where it is
  // "Found" is only claimed when it was measured: without enough question searches to judge, the stage stays where it is.
  const foundDone = pagesRead >= 5 && (period.recent || 0) > 0 && Boolean(questions) && questions.percent >= 50;
  const trustRan = (trustQ.rows[0]?.ran || 0) > 0;
  const trustOpen = recsQ.rows.some((r) => (r.detecting_agents || []).includes('trust-compliance') && r.priority !== 'low');
  const trustedDone = foundDone && trustRan && !trustOpen;
  const hasVisitorData = (postQ.rows[0]?.n || 0) > 0;
  out.stages = stageProgress(set?.stages || [], { foundDone, trustedDone, convertDone: false });
  out.stageNote = out.stages.find((s) => s.state === 'now')?.key === 'convert' && !hasVisitorData ? 'Visitor data is not connected yet, so we cannot measure whether visitors convert.' : null;

  // what is moving: only with two comparable periods of history
  if (period.history_days >= MIN_HISTORY_DAYS) {
    const byQuery = new Map();
    for (const r of histQ.rows) {
      const days = Math.floor((now - new Date(r.date)) / 86_400_000);
      const e = byQuery.get(r.query) || { recent: 0, prior: 0 };
      if (days <= 45) e.recent += Number(r.impressions) || 0; else e.prior += Number(r.impressions) || 0;
      byQuery.set(r.query, e);
    }
    const moving = [];
    for (const c of clusterQ.rows) {
      let kws = c.keywords_json; if (typeof kws === 'string') { try { kws = JSON.parse(kws); } catch { kws = []; } }
      let recent = 0, prior = 0;
      for (const k of kws || []) { const e = byQuery.get(k.keyword); if (e) { recent += e.recent; prior += e.prior; } }
      if (prior >= 50) moving.push({ topic: c.cluster_name, change: pct(recent, prior), recent });
    }
    moving.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    if (moving.length) out.moving = moving.slice(0, 4);
  }

  // strongest area: the topic cluster that already ranks best and is the biggest
  const strong = clusterQ.rows.filter((c) => Number(c.avg_position) > 0 && Number(c.avg_position) <= ANSWERED_POSITION).sort((a, b) => b.avg_impressions - a.avg_impressions)[0];
  out.strongestArea = strong?.cluster_name || null;
  out.biggestGap = moves[0]?.title || null;

  out.keyDates = upcomingDates(set?.keyDates, now);
  out.keyDatesNote = 'Typical for this industry. Not measured from your data.';

  const facts = radarQ.rows[0]?.facts; const f = typeof facts === 'string' ? JSON.parse(facts) : facts;
  out.news = (f?.findings || []).slice(0, 3).map((x) => x?.evidence?.sources?.[0]).filter(Boolean).map((s) => ({ title: s.title, url: s.url, source: s.source, publishedAt: s.publishedAt }));

  // lessons from other projects: counts only, via the existing shared-knowledge reader
  try {
    const intel = await (deps.getIndustryIntelligence || (await import('./industry-intelligence.js')).getIndustryIntelligence)(siteId, { deps: { query } });
    const learned = [...(intel.validated || []), ...(intel.emerging || [])].filter((i) => i.source === 'cross-project').slice(0, 3);
    out.lessons = learned.map((i) => ({ claim: i.claim, label: i.label === 'validated' ? 'Validated' : 'Early signal', projects: i.evidence?.sites ?? null }));
  } catch { out.lessons = []; }

  return out;
}
