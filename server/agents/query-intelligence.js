import { getGscBreakdownRange, getTopMovers, getCannibalizedQueries, getSiteById, getBreakdownDataDates } from '../store/read.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { pickCannibalizationWinner } from './lib/cannibalization-decision.js';
import { priorPeriod } from '../util/dates.js';
import { callLLM } from '../llm.js';
import { assessWindows, clipWindowToLag, GSC_LAG_DAYS } from './lib/window-coverage.js';

export const meta = {
  id: 'query-intelligence',
  name: 'Query Intelligence Agent',
  description: 'Surfaces the search queries driving (or dragging) organic performance.',
  category: 'seo',
  version: 3,
  requiresCapabilities: ['gsc'],
};

// A branded query (the site's own name) legitimately shows many of the
// site's own pages clustered at position ~1 — real Google sitelinks
// behavior for a brand search, not cannibalization. Filtered out using the
// site's own real `name`, never a guessed brand list.
export function isBrandedQuery(query, siteName) {
  if (!siteName) return false;
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normalizedName = normalize(siteName);
  if (!normalizedName) return false;
  // Padded-space containment on the already-tokenized string, not a bare
  // substring check — a bare .includes() false-negatives real cannibalization
  // for a short/generic brand name (e.g. site "Go" would suppress every
  // legitimate "golang" query as if it were a branded self-match).
  if (` ${normalize(query)} `.includes(` ${normalizedName} `)) return true;
  // Also a brand query when every token of the query is a token of the site
  // name: a site called "Admizz Education" is searched as just "admizz", and
  // that search legitimately shows several of its own pages as sitelinks.
  // Subset (not overlap), so "education loan" does not count as branded just
  // because it shares one generic word with the name.
  const nameTokens = new Set(normalizedName.split(' '));
  const queryTokens = normalize(query).split(' ').filter(Boolean);
  return queryTokens.length > 0 && queryTokens.every((t) => nameTokens.has(t));
}

// A losing page must hold at least this share of the query's clicks for the
// pair to count as cannibalization: a page with 1 click out of 60 is not
// splitting anything, it is just ranking.
export const MIN_LOSER_CLICK_SHARE = 0.10;
// Query movers below this many clicks (in the larger period) are noise.
export const MIN_MOVER_CLICKS = 5;

export async function run({ siteId, start, end }) {
  const prior = priorPeriod(start, end);

  // Windows end at 'today' but GSC lags ~3 days, and gsc_breakdown may only
  // start part-way through the prior window — compare only when both windows
  // are real (see lib/window-coverage.js), else abstain from movers.
  const dates = await getBreakdownDataDates(siteId, 'gsc', 'query', prior.start, end).catch(() => null);
  const windows = assessWindows({ start, end }, prior, dates, { lagDays: GSC_LAG_DAYS });
  const gscRange = windows.ok ? windows.recent : (clipWindowToLag({ start, end }, GSC_LAG_DAYS) || { start, end });
  // gsc_breakdown keeps only the top-N queries per day (and anonymised
  // queries not at all), so the mover filter requires a real row in BOTH
  // windows plus a floor/significance test — 'dropped to 0' is usually
  // 'fell out of the top-N', and '2 to 0' is noise.
  const moversEmpty = { gainers: [], droppers: [] };
  const [topQueries, movers, cannibalizedRaw, site] = await Promise.all([
    getGscBreakdownRange(siteId, gscRange.start, gscRange.end, 'query', 10),
    windows.ok
      ? getTopMovers(siteId, windows.recent, windows.prior, 8, { minClicks: MIN_MOVER_CLICKS, significantZ: 2, requireBoth: true })
      : Promise.resolve(moversEmpty),
    getCannibalizedQueries(siteId, gscRange.start, gscRange.end),
    getSiteById(siteId),
  ]);
  const moverComparison = { status: windows.ok ? 'ok' : 'insufficient-data', reason: windows.reason };
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
    whyItMatters: `"${d.query}" clicks dropped from ${d.prior} to ${d.recent} (${windows.recent.start} to ${windows.recent.end} vs ${windows.prior.start} to ${windows.prior.end}).`,
    priority: dropperPriorities[i],
    recommendedAction: null,
    expectedImpact: { label: impactFromPriority(dropperPriorities[i]), basis: 'computed', value: Math.abs(d.delta) },
  }));

  // Real cannibalization: 2+ of the site's OWN pages both genuinely rank
  // for the same real query, splitting clicks/signal instead of one page
  // owning it — see store/read.js's getCannibalizedQueries.
  //
  // pickCannibalizationWinner (lib/cannibalization-decision.js) decides the
  // owner from the SAME real evidence already computed below (clicks,
  // impressions, position, URL-slug relevance) — a real, auditable,
  // evidence-based decision, not a human blocker for a call the data can
  // already answer. One finding per LOSING page (matching this codebase's
  // "one finding, one draftable action" convention elsewhere, e.g.
  // technical-seo's per-page findings), each recommending internal-links
  // with mustLinkTo pinned to the decided winner — reinforces the winner's
  // ranking signal without touching or damaging the losing page's own
  // content, the smallest safe change that resolves the competition.
  const cannibalPriorities = priorityByRank(cannibalized);
  const cannibalFindings = cannibalized.flatMap((c, i) => {
    const totalClicks = c.pages.reduce((s, p) => s + Number(p.clicks), 0);
    const pageList = c.pages.map((p) => `${p.page} (pos ${p.avg_position}, ${p.clicks} clicks)`).join(' vs. ');
    const evidencePages = c.pages.map((p) => ({ page: p.page, clicks: Number(p.clicks), impressions: Number(p.impressions), avgPosition: Number(p.avg_position) }));
    const { winner, losers: allLosers, scoring } = pickCannibalizationWinner(c.query, evidencePages);
    // Only a loser that really holds a share of the query's clicks is being
    // split with the winner; with no clicks at all there is nothing to split.
    const losers = totalClicks > 0
      ? allLosers.filter((lp) => (evidencePages.find((p) => p.page === lp)?.clicks ?? 0) / totalClicks >= MIN_LOSER_CLICK_SHARE)
      : [];
    return losers.map((loserPage) => makeFinding({
      id: `query-intelligence:cannibalization:${c.query}:${loserPage}`,
      evidence: { query: c.query, pages: evidencePages, winner, scoring },
      whyItMatters: `${c.pages.length} pages both rank for "${c.query}" — ${pageList} — splitting clicks and ranking signal instead of one page owning it. Real GSC evidence (clicks, position, URL relevance — see scoring) favors ${winner} as the owner.`,
      priority: cannibalPriorities[i],
      recommendedAction: {
        label: `Strengthen internal linking to the page that should own "${c.query}"`,
        generatorId: 'internal-links',
        params: { page: loserPage, mustLinkTo: winner },
      },
      expectedImpact: { label: impactFromPriority(cannibalPriorities[i]), basis: 'computed', value: totalClicks },
    }));
  });

  const findings = [...dropperFindings, ...cannibalFindings];

  const facts = {
    rangeStart: windows.recent.start,
    rangeEnd: windows.recent.end,
    priorStart: windows.prior.start,
    priorEnd: windows.prior.end,
    moverComparison,
    topQueries,
    gainers: movers.gainers,
    droppers: movers.droppers,
    cannibalizedQueries: cannibalized,
    findings,
  };

  const system = 'You are an SEO analyst summarizing search query movement for a non-technical site owner. ' +
    'Given top queries, gainers/droppers (the requested period vs an equal-length prior period), and any real ' +
    'query cannibalization (2+ of the site\'s own pages both ranking for the same query), write 2-3 sentences ' +
    'highlighting the most notable gains/drops and, if present, the clearest cannibalization case. Describe ' +
    'cannibalization neutrally — do NOT say "severe", "serious" or "damaging" unless one page has clearly lost ' +
    'meaningful clicks to another; most are mild. If moverComparison.status is "insufficient-data", say the ' +
    'gain/drop comparison is not available and why; never describe movement. A query missing from one period was ' +
    'not necessarily at zero clicks. Use ONLY the numbers given, never compute your own percentages. Plain text, no markdown, no bullets.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const narrative = await callLLM(system, user, { maxTokens: 250 })
    .catch((err) => { console.warn('[agents] query-intelligence narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
