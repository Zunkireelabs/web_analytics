import { getGa4BreakdownRange, getGa4BreakdownDelta, getSearchPerformanceRange } from '../store/read.js';
import { flagLowCtr } from './lib/ctr-anomaly.js';
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
};

const TOP_LIMIT = 10;
const DELTA_LIMIT = 8;

export async function run({ siteId, start, end }) {
  const prior = priorPeriod(start, end);

  const [countryRows, countryDelta, cityRows, cityDelta, languageRows, gscCountryPerf] = await Promise.all([
    getGa4BreakdownRange(siteId, start, end, 'country', TOP_LIMIT),
    getGa4BreakdownDelta(siteId, 'country', { start, end }, prior, DELTA_LIMIT),
    getGa4BreakdownRange(siteId, start, end, 'city', TOP_LIMIT),
    getGa4BreakdownDelta(siteId, 'city', { start, end }, prior, DELTA_LIMIT),
    getGa4BreakdownRange(siteId, start, end, 'language', TOP_LIMIT),
    getSearchPerformanceRange(siteId, start, end, 'country', 50),
  ]);

  // GA4's own 'country' dimension already returns readable names (e.g.
  // "Nepal"); GSC's country breakdown uses ISO-3 codes, so it's converted
  // for display. The two are kept as separate sections below rather than
  // joined — GSC codes don't reliably map 1:1 onto GA4's country names for
  // every country, and joining them wouldn't be worth the loss of fidelity.
  const topCountries = countryRows.map((r) => ({ country: r.dim_value, sessions: Number(r.sessions), users: Number(r.users) }));
  const growingMarkets = countryDelta.gainers.map((r) => ({ country: r.dim_value, recent: Number(r.recent), prior: Number(r.prior), delta: Number(r.delta) }));
  const decliningMarkets = countryDelta.droppers.map((r) => ({ country: r.dim_value, recent: Number(r.recent), prior: Number(r.prior), delta: Number(r.delta) }));

  const topCities = cityRows.map((r) => ({ city: r.dim_value, sessions: Number(r.sessions), users: Number(r.users) }));
  const growingCities = cityDelta.gainers.map((r) => ({ city: r.dim_value, recent: Number(r.recent), prior: Number(r.prior), delta: Number(r.delta) }));
  const decliningCities = cityDelta.droppers.map((r) => ({ city: r.dim_value, recent: Number(r.recent), prior: Number(r.prior), delta: Number(r.delta) }));

  const topLanguages = languageRows.map((r) => ({ language: r.dim_value, sessions: Number(r.sessions), users: Number(r.users) }));

  const gscCountries = gscCountryPerf.map((c) => ({
    country: countryName(c.dim_value),
    clicks: Number(c.clicks),
    impressions: Number(c.impressions),
    ctr: Number(c.ctr),
    avgPosition: c.avg_position != null ? Number(c.avg_position) : null,
  }));
  const lowCtrCountries = flagLowCtr(gscCountries);

  // Structured, generator-mappable recommendation candidates — grounded only
  // in the real growth deltas/session counts above, never a claim about what
  // content currently exists. Kept to the top 1-2 real signals of each kind
  // to avoid flooding the Action Center with noise. `magnitude`/`evidence`
  // are transient (used only to rank findings below), stripped from the
  // public `recommendations` facts field.
  const recCandidates = [];
  const topMarket = growingMarkets[0];
  if (topMarket) {
    recCandidates.push({
      tag: 'Generate Landing Page', generatorId: 'landing-page',
      reason: `${topMarket.country} grew from ${topMarket.prior} to ${topMarket.recent} sessions this period.`,
      params: { market: topMarket.country, context: `Sessions grew from ${topMarket.prior} to ${topMarket.recent} (${start} to ${end}).` },
      magnitude: topMarket.delta,
      evidence: { country: topMarket.country, prior: topMarket.prior, recent: topMarket.recent, delta: topMarket.delta },
    });
  }
  const topCity = growingCities[0];
  if (topCity) {
    recCandidates.push({
      tag: 'Generate Landing Page', generatorId: 'landing-page',
      reason: `${topCity.city} grew from ${topCity.prior} to ${topCity.recent} sessions this period.`,
      params: { city: topCity.city, context: `Sessions grew from ${topCity.prior} to ${topCity.recent} (${start} to ${end}).` },
      magnitude: topCity.delta,
      evidence: { city: topCity.city, prior: topCity.prior, recent: topCity.recent, delta: topCity.delta },
    });
  }
  // Secondary languages (beyond the #1 by session volume) with any real
  // traffic — a real signal of an audience segment worth localizing for.
  for (const lang of topLanguages.slice(1, 3).filter((l) => l.sessions > 0)) {
    recCandidates.push({
      tag: 'Generate Translation', generatorId: 'translation',
      reason: `${lang.language} had ${lang.sessions} real session(s) this period.`,
      params: { targetLanguage: lang.language },
      magnitude: lang.sessions,
      evidence: { language: lang.language, sessions: lang.sessions },
    });
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
    lowCtrCountries,
    recommendations,
    findings,
  };

  const system = 'You are a growth strategist writing for a non-technical site owner, analyzing geography and ' +
    'language data. Given growing/declining markets and cities (real GA4 session deltas, requested period vs an ' +
    'equal-length prior period), top languages, and low-CTR countries (this site\'s own GSC search CTR relative ' +
    'to its own cross-country average — not an external benchmark), write 3-4 sentences: name the fastest-growing ' +
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
