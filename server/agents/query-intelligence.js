import { getGscBreakdownRange, getTopMovers, getCannibalizedQueries, getSiteById } from '../store/read.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { priorPeriod } from '../util/dates.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'query-intelligence',
  name: 'Query Intelligence Agent',
  description: 'Surfaces the search queries driving (or dragging) organic performance.',
  category: 'seo',
  version: 3,
};

// A branded query (the site's own name) legitimately shows many of the
// site's own pages clustered at position ~1 — real Google sitelinks
// behavior for a brand search, not cannibalization. Filtered out using the
// site's own real `name`, never a guessed brand list.
function isBrandedQuery(query, siteName) {
  if (!siteName) return false;
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normalizedName = normalize(siteName);
  if (!normalizedName) return false;
  // Padded-space containment on the already-tokenized string, not a bare
  // substring check — a bare .includes() false-negatives real cannibalization
  // for a short/generic brand name (e.g. site "Go" would suppress every
  // legitimate "golang" query as if it were a branded self-match).
  return ` ${normalize(query)} `.includes(` ${normalizedName} `);
}

export async function run({ siteId, start, end }) {
  const prior = priorPeriod(start, end);
  const [topQueries, movers, cannibalizedRaw, site] = await Promise.all([
    getGscBreakdownRange(siteId, start, end, 'query', 10),
    getTopMovers(siteId, { start, end }, prior, 8),
    getCannibalizedQueries(siteId, start, end),
    getSiteById(siteId),
  ]);
  const cannibalized = cannibalizedRaw.filter((c) => !isBrandedQuery(c.query, site?.name));

  // This agent's first-ever structured findings: real query drops past a
  // real (non-zero) threshold. No draft generator fits "investigate why a
  // query dropped" — recommendedAction stays honestly null, same pattern as
  // device-intelligence, rather than forcing an ungrounded action.
  // `movers.droppers` is already sorted biggest-drop-first.
  const dropperPriorities = priorityByRank(movers.droppers);
  const dropperFindings = movers.droppers.map((d, i) => makeFinding({
    id: `query-intelligence:dropper:${d.query}`,
    evidence: { query: d.query, recent: d.recent, prior: d.prior, delta: d.delta },
    whyItMatters: `"${d.query}" clicks dropped from ${d.prior} to ${d.recent} (${start} to ${end} vs the prior period).`,
    priority: dropperPriorities[i],
    recommendedAction: null,
    expectedImpact: { label: impactFromPriority(dropperPriorities[i]), basis: 'computed', value: Math.abs(d.delta) },
  }));

  // Real cannibalization: 2+ of the site's OWN pages both genuinely rank
  // for the same real query, splitting clicks/signal instead of one page
  // owning it — see store/read.js's getCannibalizedQueries. No draft
  // generator fits this (deciding which page should "own" a query is a
  // real editorial/business call, not something safe to auto-draft), so
  // recommendedAction stays honestly null, same as the droppers above.
  const cannibalPriorities = priorityByRank(cannibalized);
  const cannibalFindings = cannibalized.map((c, i) => {
    const totalClicks = c.pages.reduce((s, p) => s + Number(p.clicks), 0);
    const pageList = c.pages.map((p) => `${p.page} (pos ${p.avg_position}, ${p.clicks} clicks)`).join(' vs. ');
    return makeFinding({
      id: `query-intelligence:cannibalization:${c.query}`,
      evidence: {
        query: c.query,
        pages: c.pages.map((p) => ({ page: p.page, clicks: Number(p.clicks), impressions: Number(p.impressions), avgPosition: Number(p.avg_position) })),
      },
      whyItMatters: `${c.pages.length} pages both rank for "${c.query}" — ${pageList} — splitting clicks and ranking signal instead of one page owning it.`,
      priority: cannibalPriorities[i],
      recommendedAction: null,
      expectedImpact: { label: impactFromPriority(cannibalPriorities[i]), basis: 'computed', value: totalClicks },
    });
  });

  const findings = [...dropperFindings, ...cannibalFindings];

  const facts = {
    rangeStart: start,
    rangeEnd: end,
    priorStart: prior.start,
    priorEnd: prior.end,
    topQueries,
    gainers: movers.gainers,
    droppers: movers.droppers,
    cannibalizedQueries: cannibalized,
    findings,
  };

  const system = 'You are an SEO analyst summarizing search query movement for a non-technical site owner. ' +
    'Given top queries, gainers/droppers (the requested period vs an equal-length prior period), and any real ' +
    'query cannibalization (2+ of the site\'s own pages both ranking for the same query), write 2-3 sentences ' +
    'highlighting the most notable gains/drops and, if present, the most damaging cannibalization case. Use ONLY ' +
    'the numbers given, never compute your own percentages. Plain text, no markdown, no bullets.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const narrative = await callLLM(system, user, { maxTokens: 250 })
    .catch((err) => { console.warn('[agents] query-intelligence narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
