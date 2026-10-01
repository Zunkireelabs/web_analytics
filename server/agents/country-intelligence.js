import { getGa4BreakdownRange, getBreakdownDataDates, getSearchPerformanceRange, getSiteById } from '../store/read.js';
import { knownDomain, filterOwnDomainPages } from './lib/site-domain.js';
import { flagLowCtrSignificant } from './lib/ctr-anomaly.js';
import { assessWindows, clipWindowToLag, computeShareShifts, splitShareShifts, isUnattributedDim, GSC_LAG_DAYS } from './lib/window-coverage.js';
import { effortForGenerator } from './lib/page-content.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { priorPeriod } from '../util/dates.js';
import { countryName } from '../util/countries.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'country-intelligence',
  name: 'Country Intelligence Agent',
  description: 'Analyzes countries, cities, and languages to surface growing/declining markets and localization opportunities.',
  category: 'geo',
  version: 2,
  requiresCapabilities: ['gsc', 'ga4'],
};

const TOP_LIMIT = 10;
const DELTA_LIMIT = 8;
// Generating a landing page is a real, costly content-generation action (a
// whole new page, drafted and PR'd) — unlike the growingMarkets/growingCities
// facts feeding the narrative (fine to show any real gainer, however small),
// a recommendation to actually build one needs a real signal behind it, not
// statistical noise. Real report: "India grew from 0 to 1 sessions" (a
// single session) was surfacing as a "Generate Landing Page" recommendation
// — growingMarkets[0]/growingCities[0] is just the single largest delta
// among gainers with zero floor, so a market's very first visitor ever
// (0 -> 1, delta 1) ranks #1 whenever nothing else grew by more. Mirrors the
// MIN_IMPRESSIONS convention opportunity.js/competitor-intelligence.js
// already use to keep a low-volume metric from driving a recommendation.
const MIN_SESSIONS_FOR_LANDING_PAGE = 10;

// Highest-delta gainer that also clears the real-volume floor — exported so
// the threshold behavior (see MIN_SESSIONS_FOR_LANDING_PAGE above) is
// directly unit-testable without mocking this file's full GA4/GSC data
// pipeline.
//
// Also drops '(not set)'/'(other)' (never a real market), and — when the rows
// carry a share change (growingMarkets/growingCities do) — picks the biggest
// SHARE gainer rather than the biggest absolute delta: during a whole-site
// surge the largest market always has the largest absolute delta even though
// nothing about the mix moved. Coverage of the prior window is enforced by
// run() before any gainer reaches here, so a prior of 0 is a real 0.
export function topGainerAboveThreshold(gainers, minSessions = MIN_SESSIONS_FOR_LANDING_PAGE) {
  const eligible = gainers.filter((g) => !isUnattributedDim(g.country ?? g.city) && g.recent >= minSessions
    && (g.shareDeltaPp == null || g.shareDeltaPp > 0));
  if (!eligible.length) return null;
  if (eligible.every((g) => g.shareDeltaPp != null)) return [...eligible].sort((a, b) => b.shareDeltaPp - a.shareDeltaPp)[0];
  return eligible[0];
}

// A market/city whose share of sessions moved less than this is mix noise.
const MIN_MARKET_SHARE_SHIFT_PP = 2;

// Share-of-sessions movers for one GA4 dimension, behind a coverage guard.
// GA4 data begins when a property was connected (site 8862: 3 days of prior
// data; site 8864: none), so an unguarded prior window turned "data started"
// into "Nepal grew from 31 to 599 sessions".
async function shareMovers(siteId, dimType, recent, prior, limit) {
  const dates = await getBreakdownDataDates(siteId, 'ga4', dimType, prior.start, recent.end).catch(() => null);
  const w = assessWindows(recent, prior, dates, { lagDays: 0 });
  if (!w.ok) return { gainers: [], droppers: [], windows: w, status: 'insufficient-data' };
  const [recentRows, priorRows] = await Promise.all([
    getGa4BreakdownRange(siteId, w.recent.start, w.recent.end, dimType, 500),
    getGa4BreakdownRange(siteId, w.prior.start, w.prior.end, dimType, 500),
  ]);
  const { gainers, droppers } = splitShareShifts(computeShareShifts(recentRows, priorRows), { minShiftPp: MIN_MARKET_SHARE_SHIFT_PP, limit });
  return { gainers, droppers, windows: w, status: 'ok' };
}

export async function run({ siteId, start, end }) {
  const prior = priorPeriod(start, end);

  // GSC's last ~3 days are not final; clip the GSC windows to the lag.
  const gscWindow = clipWindowToLag({ start, end }, GSC_LAG_DAYS) || { start, end };
  const [site, countryRows, countryDelta, cityRows, cityDelta, languageRows, gscCountryPerf, gscTopPagesRaw] = await Promise.all([
    getSiteById(siteId),
    getGa4BreakdownRange(siteId, start, end, 'country', TOP_LIMIT),
    shareMovers(siteId, 'country', { start, end }, prior, DELTA_LIMIT),
    getGa4BreakdownRange(siteId, start, end, 'city', TOP_LIMIT),
    shareMovers(siteId, 'city', { start, end }, prior, DELTA_LIMIT),
    getGa4BreakdownRange(siteId, start, end, 'language', TOP_LIMIT),
    getSearchPerformanceRange(siteId, gscWindow.start, gscWindow.end, 'country', 50),
    getSearchPerformanceRange(siteId, gscWindow.start, gscWindow.end, 'page', TOP_LIMIT),
  ]);
  // knownDomain (primary domain only), not ownDomains — see candidate-pages.js's
  // own comment on this same 2026-08-24 fix; a finding-generating agent must
  // only ever pick a page from the site's own primary domain, never a
  // registered-but-separate additional_own_domain like edgex./zenly.zunkireelabs.com.
  const domain = knownDomain(site);
  // GA4 doesn't track sessions broken down by page+language together, so
  // there's no real "this language's top page" to point a translation
  // draft at — the site's own single top-traffic page (by impressions) is
  // the most defensible real, grounded stand-in. Without SOME page attached,
  // generators/translation.js has nothing to fetch and always 400s.
  const topPage = filterOwnDomainPages(gscTopPagesRaw, domain)[0]?.dim_value || null;

  // GA4's own 'country' dimension already returns readable names (e.g.
  // "Nepal"); GSC's country breakdown uses ISO-3 codes, so it's converted
  // for display. The two are kept as separate sections below rather than
  // joined — GSC codes don't reliably map 1:1 onto GA4's country names for
  // every country, and joining them wouldn't be worth the loss of fidelity.
  const shapeShift = (keyName) => (r) => ({
    [keyName]: r.key, recent: r.recent, prior: r.prior, delta: r.delta,
    recentSharePct: r.recentShare, priorSharePct: r.priorShare, shareDeltaPp: r.shareDelta,
  });
  const topCountries = countryRows.filter((r) => !isUnattributedDim(r.dim_value)).map((r) => ({ country: r.dim_value, sessions: Number(r.sessions), users: Number(r.users) }));
  const growingMarkets = countryDelta.gainers.map(shapeShift('country'));
  const decliningMarkets = countryDelta.droppers.map(shapeShift('country'));

  const topCities = cityRows.filter((r) => !isUnattributedDim(r.dim_value)).map((r) => ({ city: r.dim_value, sessions: Number(r.sessions), users: Number(r.users) }));
  const growingCities = cityDelta.gainers.map(shapeShift('city'));
  const decliningCities = cityDelta.droppers.map(shapeShift('city'));

  const topLanguages = languageRows.map((r) => ({ language: r.dim_value, sessions: Number(r.sessions), users: Number(r.users) }));

  const gscCountries = gscCountryPerf.map((c) => ({
    country: countryName(c.dim_value),
    clicks: Number(c.clicks),
    impressions: Number(c.impressions),
    ctr: Number(c.ctr),
    avgPosition: c.avg_position != null ? Number(c.avg_position) : null,
  }));
  // Impression-weighted + z-tested + position-aware; a country that merely
  // ranks worse is `confoundedCountries`, context only.
  const { flagged: lowCtrCountries, confounded: confoundedCountries } = flagLowCtrSignificant(gscCountries);

  // Structured, generator-mappable recommendation candidates — grounded only
  // in the real growth deltas/session counts above, never a claim about what
  // content currently exists. Kept to the top 1-2 real signals of each kind
  // to avoid flooding the Action Center with noise. `magnitude`/`evidence`
  // are transient (used only to rank findings below), stripped from the
  // public `recommendations` facts field.
  const recCandidates = [];
  const topMarket = topGainerAboveThreshold(growingMarkets);
  if (topMarket) {
    recCandidates.push({
      tag: 'Generate Landing Page', generatorId: 'landing-page',
      reason: `${topMarket.country}'s share of sessions rose from ${topMarket.priorSharePct ?? '?'}% to ${topMarket.recentSharePct ?? '?'}% this period (${topMarket.prior} to ${topMarket.recent} sessions).`,
      params: { market: topMarket.country, context: `Share of sessions rose from ${topMarket.priorSharePct}% to ${topMarket.recentSharePct}% (${topMarket.prior} to ${topMarket.recent} sessions, ${countryDelta.windows.recent.start} to ${countryDelta.windows.recent.end}).` },
      magnitude: topMarket.shareDeltaPp ?? topMarket.delta,
      evidence: { country: topMarket.country, prior: topMarket.prior, recent: topMarket.recent, delta: topMarket.delta, priorSharePct: topMarket.priorSharePct, recentSharePct: topMarket.recentSharePct, shareDeltaPp: topMarket.shareDeltaPp },
    });
  }
  const topCity = topGainerAboveThreshold(growingCities);
  if (topCity) {
    recCandidates.push({
      tag: 'Generate Landing Page', generatorId: 'landing-page',
      reason: `${topCity.city}'s share of sessions rose from ${topCity.priorSharePct ?? '?'}% to ${topCity.recentSharePct ?? '?'}% this period (${topCity.prior} to ${topCity.recent} sessions).`,
      params: { city: topCity.city, context: `Share of sessions rose from ${topCity.priorSharePct}% to ${topCity.recentSharePct}% (${topCity.prior} to ${topCity.recent} sessions, ${cityDelta.windows.recent.start} to ${cityDelta.windows.recent.end}).` },
      magnitude: topCity.shareDeltaPp ?? topCity.delta,
      evidence: { city: topCity.city, prior: topCity.prior, recent: topCity.recent, delta: topCity.delta, priorSharePct: topCity.priorSharePct, recentSharePct: topCity.recentSharePct, shareDeltaPp: topCity.shareDeltaPp },
    });
  }
  // Secondary languages (beyond the #1 by session volume) with any real
  // traffic — a real signal of an audience segment worth localizing for.
  // Requires a real page to translate (generators/translation.js needs
  // page or text) — skipped entirely when the site has no page data yet,
  // rather than emitting a recommendation that always fails to generate.
  if (topPage) {
    for (const lang of topLanguages.slice(1, 3).filter((l) => l.sessions > 0)) {
      recCandidates.push({
        tag: 'Generate Translation', generatorId: 'translation',
        reason: `${lang.language} had ${lang.sessions} real session(s) this period — translating the site's top page (${topPage}) is a concrete first step.`,
        params: { targetLanguage: lang.language, page: topPage },
        magnitude: lang.sessions,
        evidence: { language: lang.language, sessions: lang.sessions, page: topPage },
      });
    }
  }
  const recommendations = recCandidates.map(({ magnitude, evidence, ...r }) => r);

  const rankedCandidates = [...recCandidates].sort((a, b) => b.magnitude - a.magnitude);
  const priorityByCandidate = new Map(rankedCandidates.map((c, i) => [c, priorityByRank(rankedCandidates)[i]]));
  const findings = recCandidates.map((c) => {
    const priority = priorityByCandidate.get(c);
    return makeFinding({
      id: `country-intelligence:${c.tag}:${c.params.market || c.params.city || c.params.targetLanguage}`,
      evidence: c.evidence,
      whyItMatters: c.reason,
      priority,
      recommendedAction: { label: c.tag, generatorId: c.generatorId, params: c.params, effort: effortForGenerator(c.generatorId) },
      expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: c.magnitude },
    });
  });

  const facts = {
    rangeStart: start, rangeEnd: end, priorStart: prior.start, priorEnd: prior.end,
    topCountries, growingMarkets, decliningMarkets,
    topCities, growingCities, decliningCities,
    topLanguages,
    lowCtrCountries, confoundedCountries,
    marketComparison: { status: countryDelta.status, reason: countryDelta.windows.reason },
    cityComparison: { status: cityDelta.status, reason: cityDelta.windows.reason },
    recommendations,
    findings,
  };

  const system = 'You are a growth strategist writing for a non-technical site owner, analyzing geography and ' +
    'language data. Given growing/declining markets and cities (each one\'s SHARE of GA4 sessions in the requested period vs an ' +
    'equal-length prior period, in percent / percentage points — not absolute session growth; if marketComparison or ' +
    'cityComparison status is "insufficient-data" there is no trustworthy comparison, say so and never describe growth ' +
    'or decline for it), top languages, and low-CTR countries (a statistically significant ' +
    'gap vs the other countries\' impression-weighted GSC CTR at comparable position; confoundedCountries merely rank ' +
    'worse — never call them a defect), write 3-4 sentences: name the fastest-growing ' +
    'market or city, any notable decline, the lowest-CTR country if any, and ONE concrete localization or search-' +
    'listing action for the fastest-growing non-dominant market/language segment (e.g. a dedicated landing page, ' +
    'translated content, localized currency/timezone display). Never claim what content currently exists on the ' +
    'site — you don\'t have that data — phrase it as a suggestion, not a stated fact about the site. Use ONLY the ' +
    'numbers given, never compute your own percentages or invent a benchmark. Plain text, no markdown, no bullets.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const narrative = await callLLM(system, user, { maxTokens: 350 })
    .catch((err) => { console.warn('[agents] country-intelligence narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
