// Real, business-grounded keyword demand — replaces the ungrounded
// "LLM guesses what people search" step for sites where DataForSEO is
// configured. Seed terms are extracted from the site's OWN crawled homepage
// content (what it actually offers), then checked against DataForSEO's
// Keyword Data API for real monthly search volume. Run once a month per
// site (see job.js's runKeywordDemandIfDue) — the existing weekly keyword-gap
// ship cycle (analyst-seo-mapping.js's qualifyAndShipContentGaps) then draws
// blog drafts and on-page keyword updates from that same batch across the
// rest of the month, same as it already does for 'claude_research' gaps.
//
// Silently no-ops when DataForSEO isn't configured — same "no fabricated
// substitute, only real or nothing" convention as authority.js/
// competitor-analysis.js's DataForSEO fallbacks. The data-analyst-agent's
// own LLM-guess research step (keyword_clustering.py's
// research_topic_keywords) keeps running for any site without DataForSEO
// configured, so a site never loses keyword-gap discovery outright while
// waiting on credentials.

import { resolveOwnDomain } from './site-domain.js';
import { analyzePageUrl } from './page-content.js';
import { callLLMForJson } from '../../llm.js';
import { configured as dataForSeoKeywordsConfigured, fetchKeywordIdeas, fetchSearchVolume } from '../../ingest/dataforseo-keywords.js';
import { saveKeywordGaps } from '../../store/data-analyst.js';
import { getLatestKeywordDemandRunDates, saveKeywordDemandRun } from '../../store/keyword-demand.js';
import { previousWeek, previousMonth, monthBounds } from '../../util/dates.js';
import { resolveSiteLocations } from './site-locations.js';

const MAX_SEED_TERMS = 8; // a homepage describes a handful of real offerings, not dozens
const MAX_GAPS_PER_RUN = 20; // one month's worth of real candidate topics — the weekly ship cycle works through these gradually, same volume as the existing LLM-research step (RESEARCH_KEYWORDS_PER_TOPIC=20)
const MAX_LLM_GUESS_PER_LOCATION = 5; // a last-resort, per-location top-up — never meant to rival a real DataForSEO batch
const DIFFICULTY_TO_PRIORITY = { low: 'high', medium: 'medium', high: 'low' }; // mirrors keyword_clustering.py's own mapping: easier to rank = higher priority

// Friendly names for the LLM-guess fallback's prompt only — real requests to
// DataForSEO always use the numeric locationCode itself (see
// site-locations.js), never a name. Only needs to cover markets this
// codebase actually configures a site for (migrations 159/162); an
// unlisted code degrades to "location code N" in the prompt, still
// functional.
const LOCATION_NAMES = {
  2840: 'the United States', 2826: 'the United Kingdom', 2356: 'India',
  2036: 'Australia', 2124: 'Canada', 2524: 'Nepal', 2756: 'Switzerland',
  2528: 'the Netherlands', 2276: 'Germany',
};

// A hybrid-scope site (real home market + real global reach, e.g. Admizz or
// Zunkiree Labs itself, see migration 159) queries more than one location —
// merge by keyword text, keeping whichever location reported the higher
// real search volume for it, then re-sort (fetchKeywordIdeas already
// returns each location's own results sorted desc by volume; merging two
// already-sorted lists needs its own re-sort, not a naive concat).
export async function fetchIdeasAcrossLocations(seedTerms, locations) {
  const byKeyword = new Map();
  const failedLocations = []; // neither real DataForSEO product could serve these at all — see guessKeywordsForLocation
  for (const location of locations) {
    // One location's failure (DataForSEO Labs' keyword_ideas product
    // supports a narrower set of markets than its SERP product — a site's
    // own home market, valid everywhere else in this codebase, can still
    // come back "Invalid Field: 'location_code'" here) must never abort the
    // whole batch: a hybrid-scope site (home market + a real global
    // market, e.g. this site itself or Admizz — migration 159) would
    // otherwise lose its OTHER, perfectly valid location's real data too,
    // for every monthly run, forever — exactly what was happening before
    // this fix.
    let ideas;
    try {
      ideas = await fetchKeywordIdeas(seedTerms, location);
    } catch (err) {
      console.warn(`[keyword-demand] location ${location.locationCode} failed on keyword_ideas: ${err.message}`);
      // Second, narrower chance before giving up on this location entirely —
      // a different DataForSEO product (Google Ads' own Search Volume data,
      // see fetchSearchVolume's own comment for why coverage can differ from
      // Labs' keyword_ideas). Real volume for the exact seed terms only,
      // never expanded into new suggestions, but still real data for a
      // location Labs can't serve at all (e.g. Nepal).
      try {
        ideas = await fetchSearchVolume(seedTerms, location);
      } catch (fallbackErr) {
        console.warn(`[keyword-demand] location ${location.locationCode} also failed on search_volume: ${fallbackErr.message}`);
        failedLocations.push(location);
        continue;
      }
    }
    for (const idea of ideas) {
      const existing = byKeyword.get(idea.keyword);
      if (!existing || (idea.searchVolume || 0) > (existing.searchVolume || 0)) {
        byKeyword.set(idea.keyword, { ...idea, locationCode: location.locationCode });
      }
    }
  }
  return { ideas: [...byKeyword.values()].sort((a, b) => b.searchVolume - a.searchVolume), failedLocations };
}

// Last resort for a location neither real DataForSEO product can serve at
// all (confirmed live for Nepal on both keyword_ideas and search_volume) —
// an LLM guess at real phrases a customer in that specific market would
// search, grounded only in this site's own real, already-extracted
// offerings. Never fabricates a searchVolume or difficulty number (there is
// none to report — this is qualitative market knowledge, not measured
// data); the caller tags these with source 'claude_research' (see
// runKeywordDemandIfDue), the same convention already used elsewhere in
// keyword_gaps for an LLM-guessed row, so a reader of that table can always
// tell measured DataForSEO demand from an educated guess, never confuse
// the two.
export async function guessKeywordsForLocation(seedTerms, location, siteId) {
  const locationName = LOCATION_NAMES[location.locationCode] || `location code ${location.locationCode}`;
  const system = (
    'You are a market-research analyst. A business offers the following services/products, extracted from ' +
    "its own real homepage content — never invent an offering not listed. DataForSEO has no real search-" +
    `volume data for ${locationName}, so suggest up to ${MAX_LLM_GUESS_PER_LOCATION} realistic search phrases ` +
    `a real customer in ${locationName} would type into Google to find a business like this. Respond with ` +
    'ONLY JSON: {"keywords": ["...", ...]}.'
  );
  const parsed = await callLLMForJson(system, `Offerings: ${seedTerms.join(', ')}`, {
    maxTokens: 300,
    tier: 'daily',
    siteId,
    validate: (p) => Array.isArray(p?.keywords),
  }).catch(() => null);

  if (!parsed) return [];
  return parsed.keywords.filter((k) => typeof k === 'string' && k.trim()).slice(0, MAX_LLM_GUESS_PER_LOCATION);
}

function difficultyBucket(score) {
  if (score == null) return 'medium';
  if (score < 34) return 'low';
  if (score < 67) return 'medium';
  return 'high';
}

// Real offering terms from the site's own homepage copy — never a guess
// about the business, and never a hardcoded seed list, so this generalizes
// to any client's site without per-site configuration.
export async function deriveSeedTermsForSite(site, { start, end }) {
  const domain = await resolveOwnDomain(site, site.id, start, end);
  if (!domain) return [];

  const fetched = await analyzePageUrl(`https://${domain}`);
  if (!fetched.ok) return [];

  const { title, metaDescription, headingOutline, bodyText } = fetched.analysis;
  const system = (
    'You are reviewing a real company website\'s own homepage content. Extract the short list of ' +
    'services or products this business ACTUALLY offers, grounded only in what this page says — ' +
    'never invent an offering the page doesn\'t mention. Each item should be a short phrase suitable ' +
    'as a keyword-research seed (e.g. "website design services", "SEO audits", "booking software for clinics"). ' +
    `Return ONLY JSON: {"offerings": ["...", ...]}, at most ${MAX_SEED_TERMS} items.`
  );
  const user = JSON.stringify({
    title,
    metaDescription,
    headings: (headingOutline || []).slice(0, 20).map((h) => h.text),
    bodyExcerpt: (bodyText || '').slice(0, 4000),
  });

  const parsed = await callLLMForJson(system, user, {
    maxTokens: 500,
    tier: 'daily',
    siteId: site.id,
    validate: (p) => Array.isArray(p?.offerings),
  }).catch(() => null);

  if (!parsed) return [];
  return parsed.offerings.filter((o) => typeof o === 'string' && o.trim()).slice(0, MAX_SEED_TERMS);
}

// Checked on the same weekly cron trigger as everything else (see
// job.js's runAgentIfDue precedent) but only does real work once a real
// calendar month has passed — DataForSEO's Keyword Data API is billed
// per-call, and search volume for a business's own offerings doesn't shift
// week to week.
export async function runKeywordDemandIfDue(site) {
  if (!dataForSeoKeywordsConfigured()) return null;

  const { year, month } = previousMonth(site.timezone);
  const threshold = monthBounds(year, month).start;
  const [latestDate] = await getLatestKeywordDemandRunDates(site.id, 1);
  if (latestDate && latestDate >= threshold) {
    console.log(`[keyword-demand] site ${site.id} already checked this month — skipping.`);
    return null;
  }

  const { start, end } = previousWeek(site.timezone);
  const seedTerms = await deriveSeedTermsForSite(site, { start, end });
  if (!seedTerms.length) {
    console.log(`[keyword-demand] site ${site.id}: no real offering terms could be extracted from its own homepage — skipping.`);
    return null;
  }

  const locations = resolveSiteLocations(site);
  const { ideas, failedLocations } = await fetchIdeasAcrossLocations(seedTerms, locations);
  const top = ideas.slice(0, MAX_GAPS_PER_RUN);

  if (top.length) {
    const gaps = top.map((idea) => ({
      topic: idea.keyword,
      reason: `Real Google search demand (~${idea.searchVolume}/mo) for this site's own offerings, from DataForSEO — not an LLM guess.`,
      priority: DIFFICULTY_TO_PRIORITY[difficultyBucket(idea.difficulty)],
      location_code: idea.locationCode,
      search_volume: idea.searchVolume ?? null,
    }));
    await saveKeywordGaps(site.id, gaps, 'dataforseo_demand');
  }

  // A location neither real DataForSEO product could serve at all (e.g.
  // Nepal) never just goes empty — an LLM-guessed, clearly-labeled batch
  // fills in for that market specifically, saved under its own 'claude_
  // research' source rather than mixed into the real dataforseo_demand
  // batch above.
  let llmGuessed = 0;
  for (const location of failedLocations) {
    const guessed = await guessKeywordsForLocation(seedTerms, location, site.id).catch(() => []);
    if (!guessed.length) continue;
    const locationName = LOCATION_NAMES[location.locationCode] || `location code ${location.locationCode}`;
    const llmGaps = guessed.map((keyword) => ({
      topic: keyword,
      reason: `LLM-suggested search phrase for ${locationName} — DataForSEO has no real search-volume data ` +
        'for this market, so this is a grounded guess, never a measured number.',
      priority: 'medium',
      location_code: location.locationCode,
    }));
    await saveKeywordGaps(site.id, llmGaps, 'claude_research');
    llmGuessed += llmGaps.length;
  }

  await saveKeywordDemandRun(site.id, seedTerms, top.length);
  console.log(
    `[keyword-demand] site ${site.id}: ${seedTerms.length} seed term(s) → ${top.length} real keyword gap(s)` +
    (llmGuessed ? ` + ${llmGuessed} LLM-guessed gap(s) for ${failedLocations.length} unsupported location(s)` : '') +
    ' saved.'
  );
  return { seedTerms: seedTerms.length, keywords: top.length, llmGuessed };
}
