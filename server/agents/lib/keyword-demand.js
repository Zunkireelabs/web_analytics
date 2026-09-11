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
import { configured as dataForSeoKeywordsConfigured, fetchKeywordIdeas } from '../../ingest/dataforseo-keywords.js';
import { saveKeywordGaps } from '../../store/data-analyst.js';
import { getLatestKeywordDemandRunDates, saveKeywordDemandRun } from '../../store/keyword-demand.js';
import { previousWeek, previousMonth, monthBounds } from '../../util/dates.js';

const MAX_SEED_TERMS = 8; // a homepage describes a handful of real offerings, not dozens
const MAX_GAPS_PER_RUN = 20; // one month's worth of real candidate topics — the weekly ship cycle works through these gradually, same volume as the existing LLM-research step (RESEARCH_KEYWORDS_PER_TOPIC=20)
const DIFFICULTY_TO_PRIORITY = { low: 'high', medium: 'medium', high: 'low' }; // mirrors keyword_clustering.py's own mapping: easier to rank = higher priority

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

  const locationCode = Number(process.env.COMPETITOR_LOCATION_CODE || 2840); // 2840 = United States, same market assumption as the SERP adapter
  const languageCode = process.env.COMPETITOR_LANGUAGE_CODE || 'en';
  const ideas = await fetchKeywordIdeas(seedTerms, { locationCode, languageCode });
  const top = ideas.slice(0, MAX_GAPS_PER_RUN);

  if (top.length) {
    const gaps = top.map((idea) => ({
      topic: idea.keyword,
      reason: `Real Google search demand (~${idea.searchVolume}/mo) for this site's own offerings, from DataForSEO — not an LLM guess.`,
      priority: DIFFICULTY_TO_PRIORITY[difficultyBucket(idea.difficulty)],
    }));
    await saveKeywordGaps(site.id, gaps, 'dataforseo_demand');
  }

  await saveKeywordDemandRun(site.id, seedTerms, top.length);
  console.log(`[keyword-demand] site ${site.id}: ${seedTerms.length} seed term(s) → ${top.length} real keyword gap(s) saved.`);
  return { seedTerms: seedTerms.length, keywords: top.length };
}
