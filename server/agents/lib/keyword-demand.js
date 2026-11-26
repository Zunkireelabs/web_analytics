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
// When DataForSEO isn't configured (or has no credit) it no-ops, and RECORDS why in keyword_discovery_status — same "no fabricated
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
import { resolveSiteLocations, LOCATION_NAMES } from './site-locations.js';
import { recordDiscoveryStatus } from '../../store/keyword-discovery-status.js';
import { todayInTz } from '../../util/dates.js';

const MAX_SEED_TERMS = 8; // a homepage describes a handful of real offerings, not dozens
const MAX_GAPS_PER_RUN = 20; // one month's worth of real candidate topics — the weekly ship cycle works through these gradually, same volume as the existing LLM-research step (RESEARCH_KEYWORDS_PER_TOPIC=20)
const MAX_LLM_GUESS_PER_LOCATION = 5; // a last-resort, per-location top-up — never meant to rival a real DataForSEO batch
const DIFFICULTY_TO_PRIORITY = { low: 'high', medium: 'medium', high: 'low' }; // mirrors keyword_clustering.py's own mapping: easier to rank = higher priority


// A hybrid-scope site (real home market + real global reach, e.g. Admizz or
// Zunkiree Labs itself, see migration 159) queries more than one location —
// merge by keyword text, keeping whichever location reported the higher
// real search volume for it, then re-sort (fetchKeywordIdeas already
// returns each location's own results sorted desc by volume; merging two
// already-sorted lists needs its own re-sort, not a naive concat).
// `siteId` is optional and only decides whether the paid call is recorded in the provider spend ledger (migration 231):
// passed, the call goes through the budgeted client; omitted (existing tests, any other caller), nothing changes.
export async function fetchIdeasAcrossLocations(seedTerms, locations, { siteId = null } = {}) {
  const byKeyword = new Map();
  const failedLocations = []; // neither real DataForSEO product could serve these at all — see guessKeywordsForLocation
  const errors = []; // why each of those failed (the provider's own message), so a person is told the real cause, e.g. HTTP 402 = no credit
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
      ideas = await fetchKeywordIdeas(seedTerms, { ...location, siteId });
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
        errors.push({ locationCode: location.locationCode, message: `${err.message} | ${fallbackErr.message}` });
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
  return { ideas: [...byKeyword.values()].sort((a, b) => b.searchVolume - a.searchVolume), failedLocations, errors };
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
    generatorId: 'keyword-research', // routed to the Claude Code worker when LLM_WORKER_MODE=on, so no API credit is needed
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
// Why a model call failed, in words a person can act on. The API providers reply with their own message; the worker module throws workerUnavailable.
export function explainModelFailure(err) {
  const m = String(err?.message || err || '');
  if (/credit balance|billing|quota|insufficient/i.test(m)) return { code: 'model_no_credit', message: 'The AI provider has no credit left, so the homepage could not be read for seed terms. Top up the provider account, or open the laptop worker.' };
  if (err?.workerUnavailable || /worker is not connected|did not answer in time/i.test(m)) return { code: 'worker_offline', message: 'The laptop worker was not connected when the homepage was read. Open the laptop during the worker window and this retries.' };
  return { code: 'model_failed', message: `The AI call that reads the homepage failed: ${m.slice(0, 160)}` };
}

export async function deriveSeedTermsForSite(site, { start, end }, { deps = {}, onReason = () => {} } = {}) {
  // The verified business profile already says what the company sells, with quoted evidence: use it, and skip fetching the homepage and
  // paying for a model call to re-derive the same thing. Customer industries are never seeds.
  try {
    const bc = await (deps.loadBusinessContext || (async (id) => (await import('../../lib/tenant-context.js')).loadBusinessContext(id, { agent: 'keyword' })))(site.id);
    if (bc?.canonical) {
      const offered = (bc.profile.fields.productsServices.value || []).map((x) => String(x.name || '').trim()).filter(Boolean);
      if (offered.length) return [...new Set(offered)].slice(0, MAX_SEED_TERMS);
    }
  } catch { /* no profile available: derive from the homepage as before */ }
  const domain = await resolveOwnDomain(site, site.id, start, end);
  if (!domain) { onReason({ code: 'no_domain', message: 'No website domain is set for this project, so there is no homepage to read.' }); return []; }

  const fetched = await analyzePageUrl(`https://${domain}`);
  if (!fetched.ok) { onReason({ code: 'homepage_unreachable', message: `The homepage ${domain} could not be fetched (${fetched.reason || fetched.error || 'no response'}).` }); return []; }

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

  let modelError = null;
  const parsed = await callLLMForJson(system, user, {
    maxTokens: 500,
    tier: 'daily',
    siteId: site.id,
    generatorId: 'keyword-research', // routed to the Claude Code worker when LLM_WORKER_MODE=on, so no API credit is needed
    validate: (p) => Array.isArray(p?.offerings),
  }).catch((err) => { modelError = err; return null; });

  if (!parsed) { onReason(modelError ? explainModelFailure(modelError) : { code: 'no_offerings_found', message: 'The homepage was read but the model returned no usable list of offerings.' }); return []; }
  const terms = parsed.offerings.filter((o) => typeof o === 'string' && o.trim()).slice(0, MAX_SEED_TERMS);
  if (!terms.length) onReason({ code: 'no_offerings_found', message: 'The homepage was read but it describes no concrete offerings to use as search seeds.' });
  return terms;
}

// Checked on the same weekly cron trigger as everything else (see
// job.js's runAgentIfDue precedent) but only does real work once a real
// calendar month has passed — DataForSEO's Keyword Data API is billed
// per-call, and search volume for a business's own offerings doesn't shift
// week to week.
export async function runKeywordDemandIfDue(site, { deps = {} } = {}) {
  const record = deps.recordDiscoveryStatus || recordDiscoveryStatus;
  const note = (status, code, message, extra = {}) => record(site.id, 'dataforseo_demand', { status, code, message, ...extra }).catch((e) => console.warn(`[keyword-demand] site ${site.id}: could not record status: ${e.message}`));
  // No paid search-volume source is not a stop: the Claude worker researches phrases from the project's own pages and services instead (saved as
  // 'claude_research', volume left EMPTY: a model never supplies a number). The paid path keeps its own status so the missing credit stays visible.
  let paid = Boolean((deps.configured || dataForSeoKeywordsConfigured)());
  if (!paid) await note('skipped', 'dataforseo_not_configured', 'DataForSEO credentials are not set on the server, so no search-volume numbers are fetched. The Claude worker researches phrases from the project\'s own pages instead (no volume attached), and its own Search Console queries still run.');

  // Once per calendar month. (This compared a Date to a string and was always false, so the paid call ran every week.)
  const { year, month } = previousMonth(site.timezone);
  const currentMonthStart = `${todayInTz(site.timezone || 'UTC').slice(0, 7)}-01`;
  const [latest] = await (deps.getLatestRunDates || getLatestKeywordDemandRunDates)(site.id, 1);
  const latestDay = latest instanceof Date ? latest.toISOString().slice(0, 10) : (latest ? String(latest).slice(0, 10) : null);
  if (latestDay && latestDay >= currentMonthStart) {
    console.log(`[keyword-demand] site ${site.id} already checked this month — skipping.`);
    return null;
  }

  const { start, end } = previousWeek(site.timezone);
  let seedReason = null;
  const seedTerms = await (deps.deriveSeedTerms || deriveSeedTermsForSite)(site, { start, end }, { onReason: (r) => { seedReason = r; } });
  if (!seedTerms.length) {
    const r = seedReason || { code: 'no_seed_terms', message: 'No offering terms could be extracted from the homepage.' };
    console.log(`[keyword-demand] site ${site.id}: skipping — ${r.code}: ${r.message}`);
    await note('blocked', r.code, `Search-volume keywords could not start: ${r.message}`);
    return null;
  }

  const locations = resolveSiteLocations(site);
  const { ideas, failedLocations, errors = [] } = paid
    ? await (deps.fetchIdeas || fetchIdeasAcrossLocations)(seedTerms, locations, { siteId: site.id })
    : { ideas: [], failedLocations: locations, errors: [] };
  const top = ideas.slice(0, MAX_GAPS_PER_RUN);

  if (top.length) {
    const gaps = top.map((idea) => ({
      topic: idea.keyword,
      reason: `Real Google search demand (~${idea.searchVolume}/mo) for this site's own offerings, from DataForSEO — not an LLM guess.`,
      priority: DIFFICULTY_TO_PRIORITY[difficultyBucket(idea.difficulty)],
      location_code: idea.locationCode,
      search_volume: idea.searchVolume ?? null,
    }));
    await (deps.saveGaps || saveKeywordGaps)(site.id, gaps, 'dataforseo_demand');
  }

  // Every location failed (HTTP 402 = no DataForSEO credit, say): do NOT record a completed run (this month's paid check would be marked done with zero
  // results and never retried), say why, and carry on with the worker's own research so the project is not left without keywords.
  let modelOnly = !paid;
  if (paid && !ideas.length && failedLocations.length && failedLocations.length === locations.length) {
    const first = errors[0]?.message || 'unknown error';
    const noCredit = /\b402\b|payment required|insufficient/i.test(first);
    console.warn(`[keyword-demand] site ${site.id}: every location failed — ${first.slice(0, 200)}`);
    await note('blocked', noCredit ? 'dataforseo_payment_required' : 'dataforseo_failed',
      noCredit ? 'DataForSEO answered HTTP 402 (no credit on the account), so no search-volume numbers could be fetched. Top up DataForSEO; this retries on the next weekly check. Meanwhile the Claude worker researches phrases from the project\'s own pages (no volume attached).'
               : `DataForSEO could not serve any of this project's markets: ${first.slice(0, 160)}. Meanwhile the Claude worker researches phrases from the project's own pages (no volume attached).`,
      { details: { seedTerms: seedTerms.length, errors: errors.slice(0, 3) } });
    modelOnly = true;
  }

  // A location neither real DataForSEO product could serve at all (e.g.
  // Nepal) never just goes empty — an LLM-guessed, clearly-labeled batch
  // fills in for that market specifically, saved under its own 'claude_
  // research' source rather than mixed into the real dataforseo_demand
  // batch above.
  let llmGuessed = 0; let guessError = null;
  for (const location of failedLocations) {
    const guessed = await (deps.guessKeywords || guessKeywordsForLocation)(seedTerms, location, site.id).catch((e) => { guessError = e; return []; });
    if (!guessed.length) continue;
    const locationName = LOCATION_NAMES[location.locationCode] || `location code ${location.locationCode}`;
    const llmGaps = guessed.map((keyword) => ({
      topic: keyword,
      reason: `LLM-suggested search phrase for ${locationName} — DataForSEO has no real search-volume data ` +
        'for this market, so this is a grounded guess, never a measured number.',
      priority: 'medium',
      location_code: location.locationCode,
    }));
    await (deps.saveGaps || saveKeywordGaps)(site.id, llmGaps, 'claude_research');
    llmGuessed += llmGaps.length;
  }

  if (modelOnly) {
    // The paid check did not happen, so no completed run is recorded (it retries); the worker's research has its own status.
    if (llmGuessed) await record(site.id, 'worker_research', { status: 'ok', code: null, message: `The Claude worker researched ${llmGuessed} phrase(s) from the project's own pages and services. They carry no search volume: a model never supplies a number.`, keywords: llmGuessed, details: { seedTerms: seedTerms.length } }).catch(() => {});
    else { const why = guessError ? explainModelFailure(guessError) : { code: 'no_phrases', message: 'The worker returned no usable phrases for this project.' };
      await record(site.id, 'worker_research', { status: 'blocked', code: why.code, message: `Model research found nothing: ${why.message}`, details: { seedTerms: seedTerms.length } }).catch(() => {}); }
    console.log(`[keyword-demand] site ${site.id}: model-only research — ${seedTerms.length} seed term(s) → ${llmGuessed} phrase(s) saved (no volume).`);
    return { seedTerms: seedTerms.length, keywords: 0, llmGuessed, modelOnly: true };
  }

  await (deps.saveRun || saveKeywordDemandRun)(site.id, seedTerms, top.length);
  await note(top.length || llmGuessed ? 'ok' : 'nothing_new', top.length || llmGuessed ? null : 'no_ideas_returned',
    top.length || llmGuessed ? `Saved ${top.length} search-volume keyword(s)${llmGuessed ? ` and ${llmGuessed} model-suggested phrase(s) (no volume attached) for markets DataForSEO cannot serve` : ''}.`
      : 'DataForSEO answered but returned no keyword ideas for this project\'s offerings.',
    { keywords: top.length + llmGuessed, details: { seedTerms: seedTerms.length } });
  console.log(
    `[keyword-demand] site ${site.id}: ${seedTerms.length} seed term(s) → ${top.length} real keyword gap(s)` +
    (llmGuessed ? ` + ${llmGuessed} LLM-guessed gap(s) for ${failedLocations.length} unsupported location(s)` : '') +
    ' saved.'
  );
  return { seedTerms: seedTerms.length, keywords: top.length, llmGuessed };
}
