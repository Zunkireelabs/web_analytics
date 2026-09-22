import { knownDomain, hostnameOf, filterOwnDomainPages } from './site-domain.js';
import {
  getRelatedQueriesForTopic, getProductCapabilities, setGapClassification, getKeywordClusters, getKeywordGaps,
  recordCapabilityVisibilitySnapshot, getRecentCapabilityVisibilitySnapshots,
  appendKeywordGapEvidenceSnapshot, updateKeywordGapStatus, getKeywordGapsInCluster,
} from '../../store/data-analyst.js';
import { getLearnedGapConfidence, temperPriorityBoost } from './gap-learning.js';
import { listPageInventory } from '../../store/page-inventory.js';
import { buildGrowthOpportunities } from './growth-opportunities.js';
import { analyzePageUrl, hasSufficientGroundingContent } from './page-content.js';
import { findOpenRecommendation, insertRecommendation, refreshRecommendationBlockState } from '../../store/recommendations.js';
import { recommendationPageKey } from './recommendation-coordinator.js';
import { riskTierForGenerator } from './risk-tiers.js';
import { impactFromPriority } from './findings.js';
import { getSiteById } from '../../store/read.js';
import { createRecommendationGates } from './recommendation-gates.js';
import { callLLMForJson } from '../../llm.js';
import { PACED_GENERATORS } from './ship-pacing.js';
import { gapActionResolver } from './gap-action-resolver.js';
// generateDraft is the exact same shared Generate -> Quality-Gate-Validate
// -> auto-fix -> Validate-again pipeline every other Action Center entry
// point already uses (manual "Generate" click, the MCP tool, seoDraftEligibility
// below) — it already runs the Design Agent stage internally
// (resolveOrCreateComponentTemplate, routes/action-center.js) for any
// generator with a real componentTemplates concept, so calling it here
// gives keyword-gap-approved recommendations the exact same
// Design-fit-before-Action-Center guarantee with no new code of its own.
import { generateDraft } from '../../routes/action-center.js';
import { countDraftsBySourceToday, countDraftsBySourceAndTypeThisWeek, hasRecentDraftOfType } from '../../store/drafts.js';

// Maps an Analyst (data-analyst-agent) insight onto the existing Action
// Center draft-generation pipeline — a completely separate system keyed by
// Node-side "findings" (see recommendations.js), which an Analyst insight
// is not.
//
// This used to document page-dimension insights as "never true today",
// because anomaly/trend-shift detection only ran on site/device/country/
// channel. That is no longer accurate: data-analyst-agent's
// gsc_page_dimension collector exists, emits dimension_type='page', and is
// registered in the nightly collector chain (app/collectors/registry.py), so
// this path is live. The comment outlived the condition it described.
//
// Returns null for anything not eligible — callers must treat null as "not
// eligible," never throw.
function isDecline(insight) {
  const e = insight?.evidence || {};
  switch (insight?.insight_type) {
    case 'trend_shift': return typeof e.pct_change === 'number' && e.pct_change < 0;
    case 'anomaly': return e.direction === 'low';
    case 'forecast_risk': return true; // a forecast_risk insight is a decline by definition
    case 'milestone': return e.direction === 'down';
    default: return false;
  }
}

// GSC's page dimension is documented to return full absolute URLs, but
// this falls back to prefixing the site's own known domain defensively
// rather than assuming that's always true.
function absolutePageUrl(site, dimensionValue) {
  if (/^https?:\/\//i.test(dimensionValue)) return dimensionValue;
  const domain = knownDomain(site);
  if (!domain) return null;
  return `https://${domain}${dimensionValue.startsWith('/') ? '' : '/'}${dimensionValue}`;
}

// Classifies a gap against this site's OWN verified product capabilities —
// the Product Understanding Layer (migration 111) — rather than treating
// every keyword gap as equally worth the same generic article. Returns null
// (never invents an answer) when the site has no verified capabilities yet,
// so gapDraftEligibility below falls back to today's blog-outline default
// instead of guessing at relevance with nothing real to check it against.
//
// search_intent mirrors what research_topic_keywords (data-analyst-agent)
// already computes per researched keyword and then discards before saving —
// this re-derives the same judgment at approval time instead of requiring a
// cross-service plumbing change to carry it through from Python.
const RELEVANCE_SYSTEM = 'You classify a single search topic against a list of a company\'s REAL, verified product ' +
  'capabilities. Never invent or assume a capability not in the given list. Respond with ONLY a JSON object: ' +
  '{"search_intent": "informational"|"commercial"|"transactional", "product_relevance": "direct"|"supporting"|"unrelated"}. ' +
  '"direct" means the topic IS a search for what one of the listed capabilities solves. "supporting" means the topic ' +
  'is related background/how-to for one of them but not a direct search for the product itself. "unrelated" means ' +
  'it doesn\'t match any listed capability.';

export async function classifyGapRelevance(siteId, gap) {
  const capabilities = await getProductCapabilities(siteId, 'verified');
  if (!capabilities.length) return null;

  const capabilityList = capabilities
    .map((c) => {
      const industries = Array.isArray(c.industries) && c.industries.length ? ` [industries: ${c.industries.join(', ')}]` : '';
      return `- ${c.name}${c.category ? ` (${c.category})` : ''}${c.description ? `: ${c.description}` : ''}${industries}`;
    })
    .join('\n');
  const user = `Topic: "${gap.topic}"${gap.reason ? `\nContext: ${gap.reason}` : ''}\n\nVerified capabilities:\n${capabilityList}`;

  try {
    const parsed = await callLLMForJson(RELEVANCE_SYSTEM, user, { maxTokens: 150, generatorId: 'gap-relevance-classifier', siteId });
    const searchIntent = ['informational', 'commercial', 'transactional'].includes(parsed?.search_intent) ? parsed.search_intent : null;
    const productRelevance = ['direct', 'supporting', 'unrelated'].includes(parsed?.product_relevance) ? parsed.product_relevance : null;
    if (!searchIntent || !productRelevance) return null;
    return { searchIntent, productRelevance };
  } catch (e) {
    console.warn(`[analyst-seo-mapping] gap relevance classification failed for gap ${gap.id}: ${e.message}`);
    return null;
  }
}

// A gap is only a TRUE content gap if nothing on the site already covers
// it — agents/clustering.py's own gap analysis only checks against
// cluster names/GSC ranking position (data-analyst-agent), never real page
// content, so a topic can still surface as a "gap" when an existing page
// already substantially covers it under different wording. This is a
// second, cheap check at approval time rather than a heavier change to the
// Python discovery pass.
//
// Word-overlap against page_inventory's real URLs (027) is a pre-filter,
// not the actual similarity judgment — it only bounds which pages are worth
// the cost of fetching and an LLM call to a handful of plausible
// candidates, never the whole site (188 pages on site 1 today; fetching and
// judging all of them per gap approval would be slow and expensive for no
// added accuracy over checking the ones whose URL already hints at the
// topic).
const STOPWORDS = new Set(['the', 'a', 'an', 'for', 'and', 'or', 'to', 'of', 'in', 'on', 'is', 'are', 'how', 'what', 'why', 'does', 'do']);
function significantWords(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

const MAX_SIMILARITY_CANDIDATES = 5;
const EXISTING_PAGE_SYSTEM = 'You check whether a candidate existing page already substantially covers a target search ' +
  'topic — not just mentions it in passing. Respond with ONLY a JSON object: {"covered_by": "<the exact URL from the ' +
  'list that covers it>"} if one does, or {"covered_by": null} if none of the given pages substantially cover the topic. ' +
  'Never pick a URL not in the given list.';

export async function findExistingPageMatch(siteId, gap) {
  const topicWords = new Set(significantWords(gap.topic));
  if (!topicWords.size) return null;

  const rawPages = await listPageInventory(siteId, { limit: 500 }).catch(() => []);
  // page_inventory is crawl/sitemap-discovered and carries no domain
  // filtering of its own — knownDomain (primary domain only), same scoping
  // as every other finding-generating agent (candidate-pages.js's own
  // comment). Without this, a topic could get "covered_by" a real page on a
  // registered-but-separate additional_own_domain (edgex./zenly.zunkireelabs.com)
  // or a foreign one entirely — gap confirmed 2026-08-24.
  const site = await getSiteById(siteId).catch(() => null);
  const domain = site ? knownDomain(site) : null;
  const pages = domain ? filterOwnDomainPages(rawPages, domain, (r) => r.page) : rawPages;
  const scored = pages
    .map((p) => {
      const urlWords = significantWords(p.page.replace(/^https?:\/\/[^/]+/, ''));
      const overlap = urlWords.filter((w) => topicWords.has(w)).length;
      return { page: p.page, overlap };
    })
    .filter((p) => p.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, MAX_SIMILARITY_CANDIDATES);
  if (!scored.length) return null;

  const fetched = await Promise.all(scored.map(async ({ page }) => {
    const result = await analyzePageUrl(page).catch(() => ({ ok: false }));
    if (!result.ok || !hasSufficientGroundingContent(result.analysis)) return null;
    return { page, excerpt: result.analysis.bodyText.slice(0, 800) };
  }));
  const candidates = fetched.filter(Boolean);
  if (!candidates.length) return null;

  const user = `Target topic: "${gap.topic}"\n\nCandidate pages:\n${candidates
    .map((c, i) => `${i + 1}. ${c.page}\n${c.excerpt}`)
    .join('\n\n')}`;

  try {
    const parsed = await callLLMForJson(EXISTING_PAGE_SYSTEM, user, { maxTokens: 100, generatorId: 'gap-existing-page-check', siteId });
    const coveredBy = typeof parsed?.covered_by === 'string' ? parsed.covered_by : null;
    // Never trust a URL the model didn't actually see — same "grounded only
    // in what's given" discipline the generators use.
    return coveredBy && candidates.some((c) => c.page === coveredBy) ? coveredBy : null;
  } catch (e) {
    console.warn(`[analyst-seo-mapping] existing-page check failed for gap ${gap.id}: ${e.message}`);
    return null;
  }
}

// Cheap, deterministic (no LLM) phrasing detection — this is a SHAPE signal,
// not a generator choice. Comparison and FAQ/question topics are handled
// explicitly below (a real safe generator when one applies, an explicit
// "requires future infrastructure" marker when none does) rather than
// silently folded into whichever generator happened to be picked, which is
// what an earlier version of this file did and is deliberately not done
// here: routing a comparison query into blog-outline with a prompt hint
// asking it to "sound like a comparison" would ship real content under a
// generic type, with no record anywhere that a proper comparison-page
// capability is actually missing.
const COMPARISON_PATTERN = /\b(vs\.?|versus|compared to|alternative(?:s)? to)\b/i;
const QUESTION_PATTERN = /^(how|what|why|does|do|can|is|are|will|should)\b/i;

function detectContentShape(topic) {
  if (COMPARISON_PATTERN.test(topic)) return 'comparison';
  if (QUESTION_PATTERN.test(topic)) return 'question';
  return null;
}

// keyword_gaps -> Action Center generator mapping. A gap is by definition a
// topic with zero real existing coverage (agents/clustering.py Step 3), so
// 'expand-content' above (which fetches and expands an EXISTING page) can
// never apply here. Confirmed against server/implementers/frontend.js's
// applyDraft dispatch (hardcodes one branch per generator id AND requires a
// matching url_file_map.newContentTargets entry per site): only
// 'blog-outline' and 'landing-page' can create a genuinely new standalone
// page today. Do not invent a new generator id to route a shape that has no
// real apply path — see the two explicit exceptions below instead, which
// use only what already exists safely:
//
//   - A question-shaped topic where findExistingPageMatch already found a
//     real existing page: routes to 'faq' (marker-merge.js), which is safe
//     specifically BECAUSE it splices into that known existing page rather
//     than trying to stand alone — a real, already-wired path, not new
//     infrastructure.
//   - A comparison-shaped topic (no safe generator exists for this at all,
//     existing or new): returns an explicit eligible:true,
//     requiresFutureInfrastructure:true result instead of either drafting
//     under a generic type or silently doing nothing. The caller records
//     this as a real, visible, blocked recommendation — a genuine
//     comparison-page opportunity the system found and could not act on
//     yet, not an opportunity that quietly vanished.
//
// Returns null for a gap with no product relevance to Zunkiree's own
// verified capabilities AND no commercial value — a real "do nothing"
// outcome (per the product-visibility spec's explicit "sometimes the
// correct decision is to do nothing") — same as when the gap itself is
// malformed (no topic) or already covered by an existing page with nothing
// further to add. Callers must treat null as "not eligible," never throw,
// same convention as seoDraftEligibility.
export function gapDraftEligibility(gap) {
  if (!gap?.id || !gap?.topic) return null;
  const findingId = `keyword-gap:${gap.id}`;
  const shape = detectContentShape(gap.topic);

  // Already covered by a real existing page — the strongest possible
  // "nothing to draft" signal, checked first regardless of shape/value. The
  // one exception: a question-shaped topic against that same page is a real
  // FAQ opportunity (see above), not nothing.
  if (gap.existing_page_match) {
    return shape === 'question'
      ? { eligible: true, generatorId: 'faq', findingId, existingPage: gap.existing_page_match }
      : null;
  }

  if (gap.product_relevance === 'unrelated' && gap.search_intent === 'informational' && gap.priority === 'low') {
    return null;
  }

  if (shape === 'comparison') {
    return {
      eligible: true,
      requiresFutureInfrastructure: true,
      findingId,
      note: 'Identified as a comparison-page opportunity, but no generator can create a standalone comparison ' +
        'page yet — this needs a new server/generators/*.js module, a new frontend.js applyDraft dispatch branch, ' +
        'and a per-site url_file_map.newContentTargets entry before it can be drafted automatically.',
    };
  }

  const isCommercialIntent = gap.search_intent === 'commercial' || gap.search_intent === 'transactional';
  const generatorId = isCommercialIntent && gap.product_relevance === 'direct' ? 'landing-page' : 'blog-outline';
  return {
    eligible: true,
    generatorId,
    findingId,
    // Question phrasing on a topic with NO existing page to splice a real
    // FAQ into is still legitimate context for whichever page-creating
    // generator was picked above — "lead with a direct answer" is good
    // advice for a brand-new article or landing page either way. This is
    // NOT the comparison case: an article/page that happens to answer a
    // question well is a correct fulfillment of that topic, not a stand-in
    // for missing infrastructure the way a comparison topic is.
    shapeHint: shape === 'question'
      ? 'This is a QUESTION-phrased query. Lead with a direct, concise answer to the literal question before any ' +
        'supporting detail — do not bury the answer under a generic introduction.'
      : null,
  };
}

// The eligibility gapDraftEligibility above would compute, overridden for one
// specific case: a human answered "write a blog post on this topic?" with Yes.
//
// That question has already made the judgment gapDraftEligibility exists to
// make, so its routing must not quietly override the answer. Left to itself it
// would send a commercial topic to landing-page (MANUAL tier — the daily run
// would never ship it), a comparison topic to the comparison-page pseudo-type
// (no generator exists), a question about an already-covered page to faq (an
// FAQ spliced into that page, not a blog post), or return null outright for a
// topic it judges not worth acting on. Every one of those silently fails to
// produce the blog the UI promised for tomorrow.
//
// Only the shape hint survives from the real classification — "this is a
// question, lead with the answer" is good guidance for the article either way.
export function requestedBlogEligibility(gap) {
  if (!gap?.id || !gap?.topic) return null;
  const classified = gapDraftEligibility(gap);
  return {
    eligible: true,
    generatorId: 'blog-outline',
    findingId: `keyword-gap:${gap.id}`,
    shapeHint: classified?.shapeHint ?? null,
  };
}

// Real "build topic cluster" support (multi-tenant growth spec): when
// find_gaps (data-analyst-agent) grouped this gap with 2+ siblings under one
// topic_cluster name (persisted + normalized server-side, see migration 156
// and _normalize_clusters), tells the generator about its real siblings —
// grounded ONLY in the other gaps' own real topic strings, never invented —
// so a pillar page is written broad enough to link out, and a supporting
// article stays narrow instead of re-covering the pillar. Returns null for
// an ungrouped gap (topic_cluster is the common case, per find_gaps' own
// "don't force it" instruction) or when this gap's siblings can't be read.
async function buildClusterContext(siteId, gap) {
  const siblings = await getKeywordGapsInCluster(siteId, gap.topic_cluster, gap.id).catch(() => []);
  if (!siblings.length) return null;
  if (gap.cluster_role === 'pillar') {
    const supporting = siblings.filter((s) => s.cluster_role === 'supporting').map((s) => s.topic);
    return supporting.length
      ? `This is the PILLAR page for the topic cluster "${gap.topic_cluster}" — write it broad enough to naturally reference, and later link out to, its planned supporting articles: ${supporting.join(', ')}.`
      : null;
  }
  const pillar = siblings.find((s) => s.cluster_role === 'pillar');
  return pillar
    ? `This is a SUPPORTING article in the topic cluster "${gap.topic_cluster}" — its pillar page covers "${pillar.topic}". Stay focused on this narrower angle rather than re-covering the pillar's full breadth; reference the pillar topic naturally where relevant.`
    : null;
}

// Turns an approved keyword gap into a real, actionable Action Center
// recommendation — Gate 1 only ("we should act on this"). It just queues a
// recommendation row; drafting, validation, PR, and the human merge
// approval (Gate 2) all still go through the Action Center's own existing,
// untouched flow (server/routes/action-center.js). Shared by both entry
// points a gap can be approved from — the Analyst page's HTTP route
// (server/routes/keywords.js) and the 'update_keyword_gap_status' MCP tool
// (mcp-server/tools/ai-actions.js) — so approval behaves identically no
// matter which one a caller used.
//
// OPTIONS, both used only by the Analyst page's "write a blog on this
// keyword?" path (the `request-blog` route in server/routes/keywords.js):
//   deferDraft      — skip the immediate generateDraft below and leave an
//                     ordinary open recommendation for the next daily
//                     auto-remediation run to draft and ship. Staff approval
//                     keeps drafting on the spot (a staff member is sitting
//                     there waiting to see the result); a client asking for a
//                     blog is explicitly asking for tomorrow's run, not a
//                     five-minute wait on their own page load.
//   clientRequested — records params.clientRequested on the recommendation so
//                     ship-pacing.js can tell an explicitly-requested blog
//                     from one the agent chose itself. That flag is the ONLY
//                     thing that lets a blog bypass blog_min_gap_days, and it
//                     is still capped at one per run — see PACED_GENERATORS.
//                     Safe to carry in params: recommendationPageKey keys
//                     blog-outline on params.topic alone, so it can't split a
//                     topic into two rows, and blog-outline.js destructures
//                     only { topic, context }.
export async function createActionCenterRecommendationForGap(siteId, gap, { deferDraft = false, clientRequested = false } = {}) {
  // Classification and the existing-page check both run once, on first
  // approval — in parallel, since neither depends on the other's result —
  // and never re-run once a value is already recorded (re-approval after a
  // dismissed draft reuses what's already known rather than re-judging
  // against a possibly-changed capability set or page inventory).
  const needsClassification = gap.search_intent == null || gap.product_relevance == null;
  const needsPageCheck = gap.existing_page_match == null;
  if (needsClassification || needsPageCheck) {
    const [classification, existingPageMatch] = await Promise.all([
      needsClassification ? classifyGapRelevance(siteId, gap).catch(() => null) : null,
      needsPageCheck ? findExistingPageMatch(siteId, gap).catch(() => null) : null,
    ]);
    if (classification || existingPageMatch) {
      // A direct product match with commercial/transactional intent outranks
      // whatever difficulty-based priority the clustering agent originally
      // guessed — commercial demand for something Zunkiree actually sells
      // matters more than raw keyword volume (product-visibility growth
      // objective, "commercial intent must matter"). Anything else keeps its
      // existing priority untouched (setGapClassification's COALESCE).
      const isCommercialIntent = classification && (classification.searchIntent === 'commercial' || classification.searchIntent === 'transactional');
      const naiveBoost = isCommercialIntent && classification.productRelevance === 'direct' ? 'high' : undefined;
      // Real learning loop, not just a static rule: THIS site's own measured
      // GSC impact from past commercial+direct gaps can withhold a boost the
      // static rule above would otherwise always grant — see gap-learning.js.
      const learnedGapMap = naiveBoost ? await getLearnedGapConfidence(siteId).catch(() => new Map()) : null;
      const boostedPriority = naiveBoost
        ? temperPriorityBoost(learnedGapMap, classification.searchIntent, classification.productRelevance, naiveBoost)
        : undefined;
      const updated = await setGapClassification(siteId, gap.id, {
        searchIntent: classification?.searchIntent, productRelevance: classification?.productRelevance,
        priority: boostedPriority, existingPageMatch,
      }).catch(() => null);
      if (updated) {
        gap = {
          ...gap, search_intent: updated.search_intent, product_relevance: updated.product_relevance,
          priority: updated.priority, existing_page_match: updated.existing_page_match,
        };
      }
    }
  }

  const eligibility = clientRequested ? requestedBlogEligibility(gap) : gapDraftEligibility(gap);
  if (!eligibility) return { eligible: false };

  const relatedQueries = await getRelatedQueriesForTopic(siteId, gap.topic);
  const evidence = relatedQueries.length
    ? `Related real GSC queries already observed: ${relatedQueries
        .map((q) => `"${q.dim_value}" (${q.impressions} impr, ${q.clicks} clicks, pos ${q.avg_position ?? '—'})`)
        .join('; ')}.`
    : 'No matching real GSC queries found for this topic in the last 90 days — a true zero-coverage gap.';
  const clusterContext = gap.topic_cluster ? await buildClusterContext(siteId, gap) : null;
  const reason = [gap.reason, evidence, clusterContext].filter(Boolean).join(' ');

  // No real generator exists for this shape (see gapDraftEligibility's own
  // doc comment) — recorded as a real, visible, blocked recommendation
  // under a pseudo type rather than either drafting it as something it
  // isn't or silently doing nothing. 'comparison-page' is never a real
  // generator id and generateDraft is never called for it (short-circuited
  // below, same as any other blocked recommendation).
  if (eligibility.requiresFutureInfrastructure) {
    const generatorId = 'comparison-page';
    const params = { topic: gap.topic, context: reason };
    const page = recommendationPageKey({ generatorId, params });
    const existing = await findOpenRecommendation(siteId, page, generatorId);
    // Only annotated on first creation, never on a re-detection of an
    // already-open recommendation — a decision-engine call every time this
    // gap is re-seen would pay LLM cost for the same already-blocked card
    // over and over with nothing new to say.
    const decision = existing ? null : await decisionEngineAnnotation(gap, siteId);
    const blockedReason = decision
      ? `${eligibility.note} Cross-domain evidence review: ${decision.rationale}`
      : eligibility.note;
    const recommendationId = existing
      ? existing.id
      : (await insertRecommendation(siteId, {
          page,
          recommendationType: generatorId,
          issue: `Keyword gap: ${gap.topic}`,
          reason,
          params,
          findingId: eligibility.findingId,
          detectingAgent: 'analyst-keyword-gaps',
          priority: gap.priority,
          riskTier: 'manual',
          blockedReason,
          // label only, value left null — see the comment on the main insert
          // below for why a real number is not invented here.
          expectedImpact: { label: impactFromPriority(gap.priority), basis: 'estimate', value: null },
        })).id;
    return {
      eligible: true, created: !existing, recommendationId, draftId: null,
      blockedReason, requiresFutureInfrastructure: true,
    };
  }

  // faq (existing-page FAQ opportunity) needs {page, query}, not {topic,
  // context} — matches faq.js's actual params contract (server/generators/
  // faq.js), not the topic-only shape blog-outline/landing-page take.
  const params = eligibility.generatorId === 'faq'
    ? { page: eligibility.existingPage, query: gap.topic }
    : {
        topic: gap.topic,
        context: eligibility.shapeHint ? `${reason} ${eligibility.shapeHint}` : reason,
        ...(clientRequested ? { clientRequested: true } : {}),
      };

  const page = recommendationPageKey({ generatorId: eligibility.generatorId, params });
  const existing = await findOpenRecommendation(siteId, page, eligibility.generatorId);

  // The same gates every other writer to this table passes through.
  // blog-outline is net-new content, so the gate that matters here is
  // newContentTargets: a tenant with no configured destination for new blog
  // files gets a visible, blocked, manual-tier recommendation carrying the
  // reason, instead of a 'safe' one that enters the unattended chain and
  // fails at apply. Never fatal — approving the gap must still succeed even
  // if we cannot reach the repo to evaluate the gates.
  const site = await getSiteById(siteId).catch(() => null);
  const gate = site
    ? await createRecommendationGates(siteId, site)
        .evaluate(eligibility.generatorId, params)
        .catch(() => ({ drop: null, blockedReason: null }))
    : { drop: null, blockedReason: null };
  if (gate.drop) return { eligible: false, dropped: gate.drop };

  let recommendationId;
  if (existing) {
    // Re-approving (or re-checking) a gap whose recommendation is already
    // open must re-sync its block state to what the gates just found —
    // otherwise a row created while, say, newContentTargets was unconfigured
    // stays frozen on that stale reason forever, even after the config gets
    // fixed, since nothing else ever revisits a content-gap-derived row (see
    // recommendation-coordinator.js's refreshBlockedRecommendations for the
    // periodic counterpart that revisits these without requiring a
    // re-approval to trigger it).
    recommendationId = existing.id;
    await refreshRecommendationBlockState(existing.id, {
      blockedReason: gate.blockedReason,
      riskTier: gate.blockedReason ? 'manual' : riskTierForGenerator(eligibility.generatorId),
    });
  } else {
    recommendationId = (await insertRecommendation(siteId, {
      page,
      recommendationType: eligibility.generatorId,
      issue: `Keyword gap: ${gap.topic}`,
      reason,
      params,
      findingId: eligibility.findingId,
      detectingAgent: 'analyst-keyword-gaps',
      priority: gap.priority,
      riskTier: gate.blockedReason ? 'manual' : riskTierForGenerator(eligibility.generatorId),
      blockedReason: gate.blockedReason,
      // No agent here computes a real numeric estimate for a keyword gap
      // (unlike technical-seo.js summing real GSC impressions) — inventing
      // one would be exactly the fabricated-metric problem this codebase
      // avoids elsewhere. label is real: impactFromPriority is the same
      // shared rank->label mapping every other agent uses (findings.js),
      // and it is the only part of expected_impact growth-scoring.js reads
      // (see that module's note on why .value has no comparable unit across
      // agents). Previously this path passed no expectedImpact at all, so
      // every keyword-gap/analyst/growth-opportunity recommendation scored
      // as if it had zero impact, regardless of real priority.
      expectedImpact: { label: impactFromPriority(gap.priority), basis: 'estimate', value: null },
    })).id;
  }

  // A blocked recommendation must not be drafted: generateDraft would hit the
  // same missing prerequisite and throw, and the catch below would record a
  // draftError that reads like a transient failure rather than the missing
  // configuration it actually is.
  if (gate.blockedReason) {
    return { eligible: true, created: !existing, recommendationId, draftId: null, blockedReason: gate.blockedReason };
  }

  // Requested for a LATER run, deliberately: the recommendation row above is
  // all tomorrow's auto-remediation pass needs to draft and ship this exactly
  // like any other safe-tier item, on the same branch/PR, in the same format.
  // Returned before the drafting block below rather than inside it so the
  // caller can tell "queued for tomorrow" from "drafted now but empty".
  if (deferDraft) {
    return { eligible: true, created: !existing, recommendationId, draftId: null, deferred: true };
  }

  // Design Agent -> Implementation -> Validation, all BEFORE this reaches a
  // human as an executable Action Center item — generateDraft is idempotent
  // per findingId (see its own docstring), so this is safe to call every
  // time a gap is approved, whether the recommendation row above was just
  // created or already existed from an earlier attempt. A human still has
  // to submit/approve the resulting draft and the existing daily-batch
  // branch/PR pipeline is untouched — this only decides what's WAITING for
  // them when they open Action Center: a real, already-validated proposed
  // change instead of a bare, unexecuted recommendation stub.
  try {
    const draft = await generateDraft(siteId, {
      generatorId: eligibility.generatorId, params, source: 'analyst-keyword-gap', findingId: eligibility.findingId,
    });
    return { eligible: true, created: !existing, recommendationId, draftId: draft.id, draftStatus: draft.status };
  } catch (err) {
    // Generation/validation failed (or the Design Agent step itself hit a
    // real error) — the recommendation stays open, but per the "failed
    // changes never become executable Action Center items" rule, no draft
    // exists for it. Never thrown further: approving the gap itself must
    // still succeed even when draft generation doesn't.
    return { eligible: true, created: !existing, recommendationId, draftId: null, draftError: err.message };
  }
}

export function seoDraftEligibility(site, insight) {
  if (!insight?.metric_key?.startsWith('gsc_')) return null;
  if (insight.dimension_type !== 'page' || !insight.dimension_value) return null;
  if (!isDecline(insight)) return null;

  const page = absolutePageUrl(site, insight.dimension_value);
  if (!page) return null;

  // GSC's page dimension is documented to return full absolute URLs, so
  // `page` can legitimately be on ANY hostname the GSC property covers —
  // including a registered additional_own_domain (edgex./zenly.zunkireelabs.com)
  // or a foreign one entirely, neither of which is in scope for THIS site's
  // Action Center (gap confirmed 2026-08-24: this bridge never checked
  // domain at all before creating a recommendation). knownDomain (primary
  // only) — never ownDomains — same scoping as every other finding-
  // generating agent's page pool, see candidate-pages.js's own comment.
  const primaryDomain = knownDomain(site);
  if (primaryDomain && hostnameOf(page) !== primaryDomain) return null;

  return {
    ...generatorForDecliningPage(insight),
    // Deterministic per (metric, type, period, page) — getDraftByFindingId's
    // idempotency check relies on this being stable across repeated calls
    // for the same finding, not random per request.
    findingId: `analyst:${insight.metric_key}:${insight.insight_type}:${insight.period_start}:${insight.dimension_value}`,
    page,
    // Only forecast_risk insights carry a real confidence value (the
    // ForecastRun's own composite score, see data-analyst-agent's
    // insights/engine.py) — everything else is an observed fact, not a
    // prediction, so there is nothing honest to attach here.
    confidence: insight.insight_type === 'forecast_risk' ? insight.confidence ?? null : null,
  };

  function generatorForDecliningPage(ins) {
    // Which KIND of decline this is decides what would actually help, and
    // the metric already says. Every branch still names a generator whose
    // params can be filled from the insight alone — nothing here guesses a
    // topic or a schema type, which is the line the original single-generator
    // mapping drew and this keeps.
    //
    // Impressions falling means fewer people are being SHOWN the page: a
    // coverage/relevance problem, so give the page more substance to match
    // more queries.
    //
    // Clicks or CTR falling while impressions hold means people SEE it and
    // don't click: a presentation problem in the result itself, which is
    // what the title and description control.
    if (ins.metric_key === 'gsc_ctr' || ins.metric_key === 'gsc_clicks') {
      return { generatorId: 'meta-title', params: { page, query: ins.dimension_value } };
    }
    // Position worsening is a competitiveness signal — answer the query more
    // directly on the page rather than rewriting how it is listed.
    if (ins.metric_key === 'gsc_position') {
      return { generatorId: 'qa-content', params: { page } };
    }
    return { generatorId: 'expand-content', params: { page } };
  }
}

// Website-wide Growth Opportunities (Analyst page, growth-opportunities.js)
// -> Action Center draft, for the four types built from an existing ranking
// page (quick-win/page1-opportunity/declining/content-expansion). Deliberately
// excludes 'content-gap': that type has zero existing page by definition
// (growth-opportunities.js's own doc comment) and already has its own
// approval path — createActionCenterRecommendationForGap above, wired through
// the gaps PUT route — which also runs relevance classification and the
// existing-page check gapDraftEligibility needs. Mirrors
// generatorForDecliningPage below: a CTR/click gap is a presentation problem
// (title/meta), a real click/position DROP on a page that already had
// traffic is a staleness problem (refresh-content — corrects/updates what's
// already there, grounded in the real trend numbers), everything else here
// is a coverage/depth problem (expand-content, which only ever ADDS new
// subtopics) — no generator here needs to guess a topic, same discipline as
// seoDraftEligibility.
const OPPORTUNITY_GENERATORS = {
  'quick-win': (opp) => ({ generatorId: 'meta-title', params: { page: opp.page, query: opp.query } }),
  'page1-opportunity': (opp) => ({ generatorId: 'expand-content', params: { page: opp.page } }),
  declining: (opp) => ({ generatorId: 'refresh-content', params: { page: opp.page, query: opp.query, trend: opp.trend || null } }),
  'content-expansion': (opp) => ({ generatorId: 'expand-content', params: { page: opp.page } }),
};

// Returns null for anything not eligible — same "never throw" convention as
// seoDraftEligibility/gapDraftEligibility above. Re-checked server-side by
// the route that calls this; the frontend's own eligibility check is only a
// UI convenience, never trusted alone.
export function opportunityDraftEligibility(site, opp) {
  const build = opp?.type && OPPORTUNITY_GENERATORS[opp.type];
  if (!build || !opp.page) return null;

  // Same primary-domain-only scoping as seoDraftEligibility — a growth
  // opportunity's page comes from gsc_query_page, which (like GSC's page
  // dimension) can legitimately name any hostname the property covers.
  const primaryDomain = knownDomain(site);
  if (primaryDomain && hostnameOf(opp.page) !== primaryDomain) return null;

  const { generatorId, params } = build(opp);
  return {
    generatorId,
    params,
    // Deterministic per (type, page, query) — matches getDraftByFindingId's
    // idempotency contract, same as every other findingId in this file.
    findingId: `growth-opportunity:${opp.type}:${opp.page}:${opp.query || ''}`,
  };
}

// AUTONOMOUS NIGHTLY SYNC — the missing last mile.
//
// The 3am pipeline (data-analyst-agent, ingest_schedule_hour_utc=3) already
// collects, forecasts and produces insights every night, including
// forecast_risk ones that predict a problem before it lands. None of it
// reached the Action Center: the only two ways an insight or a keyword gap
// could become a recommendation were a human clicking approve on one item at
// a time. Every night's analysis simply sat there.
//
// This creates RECOMMENDATIONS only — never drafts. That is deliberate: a
// recommendation then flows through the exact same risk-tier and
// auto-remediation machinery every agent finding already does, so analyst
// findings become first-class without inventing a second, parallel autonomy
// path that bypasses the gate deciding what may ship unattended.
//
// Idempotent per insight: findOpenRecommendation on the same
// (page, generatorId) key means re-running a night's insights — or running
// after a partial failure — merges rather than duplicates.
export async function syncAnalystInsightsToActionCenter(siteId, insights, { site } = {}) {
  const resolvedSite = site || await getSiteById(siteId);
  if (!resolvedSite) return { created: 0, skipped: 0, ineligible: 0 };

  let created = 0;
  let skipped = 0;
  let ineligible = 0;
  let dropped = 0;
  let blocked = 0;

  // One gates instance for the whole nightly pass, so its caches hold: one
  // repo-tree read and one soft-404 fingerprint for every insight, not one
  // per insight. Without these gates this loop was the most prolific source
  // of contradictory rows — it inserted meta-title/qa-content/expand-content
  // recommendations at the generator's own risk tier for any page the Analyst
  // flagged, with no check that the page is mapped, that its file still
  // exists, or that the page exists at all.
  const gates = createRecommendationGates(siteId, resolvedSite);

  for (const insight of insights || []) {
    const action = seoDraftEligibility(resolvedSite, insight);
    if (!action) { ineligible++; continue; }

    const page = recommendationPageKey({ generatorId: action.generatorId, params: action.params });
    const existing = await findOpenRecommendation(siteId, page, action.generatorId);
    if (existing) { skipped++; continue; }

    const gate = await gates.evaluate(action.generatorId, action.params)
      .catch(() => ({ drop: null, blockedReason: null }));
    if (gate.drop) { dropped++; continue; }
    if (gate.blockedReason) blocked++;

    // forecast_risk is a PREDICTED problem, not an observed one. Saying so in
    // the issue text matters: a human reading the Action Center needs to know
    // whether this already happened or is about to.
    const predicted = insight.insight_type === 'forecast_risk';
    await insertRecommendation(siteId, {
      page,
      recommendationType: action.generatorId,
      issue: `${predicted ? 'Predicted' : 'Detected'} ${insight.metric_key} decline on this page`,
      reason: analystReason(insight, predicted),
      params: action.params,
      findingId: action.findingId,
      detectingAgent: 'analyst-insights',
      priority: predicted ? 'medium' : 'high',
      riskTier: gate.blockedReason ? 'manual' : riskTierForGenerator(action.generatorId),
      blockedReason: gate.blockedReason,
      confidence: action.confidence,
      // See createActionCenterRecommendationForGap's comment on why label
      // (not a fabricated value) is what's set here.
      expectedImpact: { label: impactFromPriority(predicted ? 'medium' : 'high'), basis: 'estimate', value: null },
    });
    created++;
  }
  return { created, skipped, ineligible, dropped, blocked };
}

// Website-wide Growth Opportunities -> Action Center, the weekly counterpart
// to syncAnalystInsightsToActionCenter above (same idempotency, same gates
// instance reused across the whole pass). Creates recommendations only,
// never drafts, for the same reason: an unattended pass must feed the
// existing risk-tier/auto-remediation gate, not bypass it with drafts
// nothing has to review first.
//
// content-gap opportunities are skipped here (opportunityDraftEligibility
// itself returns null for them, via OPPORTUNITY_GENERATORS above) — that
// type already has its own human-reviewed approval path
// (createActionCenterRecommendationForGap via the gaps PUT route), and
// running it here too would silently short-circuit that review step.
export async function syncGrowthOpportunitiesToActionCenter(siteId, { site } = {}) {
  const resolvedSite = site || await getSiteById(siteId);
  if (!resolvedSite) return { created: 0, skipped: 0, ineligible: 0, dropped: 0, blocked: 0 };

  const { opportunities } = await buildGrowthOpportunities(siteId);

  let created = 0;
  let skipped = 0;
  let ineligible = 0;
  let dropped = 0;
  let blocked = 0;

  const gates = createRecommendationGates(siteId, resolvedSite);

  for (const opp of opportunities || []) {
    const action = opportunityDraftEligibility(resolvedSite, opp);
    if (!action) { ineligible++; continue; }

    const page = recommendationPageKey({ generatorId: action.generatorId, params: action.params });
    const existing = await findOpenRecommendation(siteId, page, action.generatorId);
    if (existing) { skipped++; continue; }

    const gate = await gates.evaluate(action.generatorId, action.params)
      .catch(() => ({ drop: null, blockedReason: null }));
    if (gate.drop) { dropped++; continue; }
    if (gate.blockedReason) blocked++;

    await insertRecommendation(siteId, {
      page,
      recommendationType: action.generatorId,
      issue: opp.query ? `Growth opportunity (${opp.type}): "${opp.query}"` : `Growth opportunity (${opp.type}) on ${opp.page}`,
      reason: opp.reason,
      params: action.params,
      findingId: action.findingId,
      detectingAgent: 'growth-opportunities',
      priority: opp.severity || 'medium',
      riskTier: gate.blockedReason ? 'manual' : riskTierForGenerator(action.generatorId),
      blockedReason: gate.blockedReason,
      // opp.opportunityScore (opportunity-scoring.js) is a real computed
      // number, but on a different scale per opportunity TYPE (quick-win vs
      // content-expansion use different underlying formulas) — not safely
      // comparable across types as a raw value, same reasoning as the other
      // three insert paths. label is derived from the same severity this row
      // already stores.
      expectedImpact: { label: impactFromPriority(opp.severity || 'medium'), basis: 'estimate', value: null },
    });
    created++;
  }
  return { created, skipped, ineligible, dropped, blocked };
}

// Content-gap autonomous shipping, weekly half: for every still-pending gap,
// (1) records this week's real-GSC evidence snapshot (migration 129's
// evidence_snapshots), and (2) runs the same lazy classification
// createActionCenterRecommendationForGap already does on first approval —
// pulled forward here so a gap's product_relevance/search_intent/
// existing_page_match are already fresh by the time the biweekly
// qualifyAndShipContentGaps pass looks at it, instead of being computed for
// the first time mid-qualification. Never throws per-gap — one gap's
// classification failure must not stop the rest of the site's pending queue
// from getting this week's observation recorded.
export async function refreshPendingKeywordGapObservations(siteId) {
  const gaps = await getKeywordGaps(siteId, 'pending_review');
  let observed = 0;
  let classified = 0;

  for (const gap of gaps) {
    try {
      const relatedQueries = await getRelatedQueriesForTopic(siteId, gap.topic);
      const impressions = relatedQueries.reduce((sum, q) => sum + (Number(q.impressions) || 0), 0);
      const bestPosition = relatedQueries.reduce((best, q) => {
        const p = Number(q.avg_position);
        return Number.isFinite(p) && (best == null || p < best) ? p : best;
      }, null);
      await appendKeywordGapEvidenceSnapshot(siteId, gap.id, {
        observed_at: new Date().toISOString(), impressions, position: bestPosition, source: 'gsc-related-queries',
      });
      observed++;
    } catch (e) {
      console.warn(`[analyst-seo-mapping] weekly evidence snapshot failed for gap ${gap.id}: ${e.message}`);
    }

    const needsClassification = gap.search_intent == null || gap.product_relevance == null || gap.existing_page_match == null;
    if (!needsClassification) continue;
    try {
      const [classification, existingPageMatch] = await Promise.all([
        gap.search_intent == null || gap.product_relevance == null ? classifyGapRelevance(siteId, gap).catch(() => null) : null,
        gap.existing_page_match == null ? findExistingPageMatch(siteId, gap).catch(() => null) : null,
      ]);
      if (classification || existingPageMatch) {
        await setGapClassification(siteId, gap.id, {
          searchIntent: classification?.searchIntent, productRelevance: classification?.productRelevance, existingPageMatch,
        });
        classified++;
      }
    } catch (e) {
      console.warn(`[analyst-seo-mapping] weekly classification refresh failed for gap ${gap.id}: ${e.message}`);
    }
  }
  return { sites: 1, gaps: gaps.length, observed, classified };
}

// Content-gap autonomous shipping, biweekly half — the missing autonomous
// path referenced in syncGrowthOpportunitiesToActionCenter's own comment
// ("content-gap opportunities are skipped here... has its own human-reviewed
// approval path"). This function IS that approval path, run unattended
// instead of by a human clicking the gaps UI, but gated far more
// conservatively than a same-day sync: a gap only qualifies once it has
// survived at least one full week of continued real demand
// (observation_count >= 2 — see refreshPendingKeywordGapObservations above),
// is relevant to a REAL, human-verified Zunkiree product capability
// ('direct' or 'supporting' — 'unrelated' never auto-qualifies, regardless
// of which product it might be for; this generalizes to every product in
// product_capabilities, not just one), and shows non-decreasing real
// impressions across its two most recent weekly snapshots (a one-off spike
// followed by a drop does not qualify) — the same "two most recent rows =
// one trend" read capability_visibility_snapshots already uses.
//
// Deliberately calls createActionCenterRecommendationForGap UNCHANGED for
// every qualifying gap — the exact function the human-approval PUT route
// (server/routes/keywords.js) calls, so generator selection
// (gapDraftEligibility: faq / landing-page / blog-outline / blocked
// comparison-page), gate-checking, and draft generation are byte-for-byte
// identical to today's manual path. This function only ever decides WHETHER
// a gap ships, never WHAT it ships as or HOW — and never touches any other
// recommendation type's approval/risk-tier behavior.
//
// dryRun: true runs the entire selection and returns each candidate's
// evidence/generator choice without calling createActionCenterRecommendationForGap
// or writing status='accepted' — genuinely read-only, for a real dry-run
// against production data before the cron entry is enabled.
export function hasStableOrGrowingDemand(gap) {
  const snapshots = Array.isArray(gap.evidence_snapshots) ? gap.evidence_snapshots : [];
  if (snapshots.length < 2) return false;
  const [prior, latest] = snapshots.slice(-2);
  const priorImpressions = Number(prior?.impressions) || 0;
  const latestImpressions = Number(latest?.impressions) || 0;
  // A gap with genuinely zero GSC signal both times (a true white-space
  // topic with no near-miss queries at all) still qualifies on relevance and
  // recurrence alone — it never had "demand" to decline in the first place.
  if (priorImpressions === 0 && latestImpressions === 0) return true;
  return latestImpressions >= priorImpressions;
}

// Monday of the ISO week containing `d`, in UTC — the JS counterpart of
// migration 143's date_trunc('week', ...)::date and of the Python collector's
// _week_start (data-analyst-agent/app/collectors/keyword_clustering.py).
// All three must agree on where a week starts; change one, change all three.
export function isoWeekStart(d = new Date()) {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay(): 0=Sunday. Monday-based offset puts Sunday 6 days after Monday.
  utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7));
  return utc.toISOString().slice(0, 10);
}

// THE source string every draft this pipeline creates is tagged with (see
// createActionCenterRecommendationForGap's generateDraft call). Deliberately
// distinct from auto-remediation.js's 'auto-remediation' so the two lanes
// stay separately attributable — which is exactly why this one needs its own
// cap below rather than inheriting that one's.
const GAP_DRAFT_SOURCE = 'analyst-keyword-gap';

// Phase 7 of the "one intelligence" consolidation plan (fix/system) — the
// one call site where decision-engine actually gets invoked from the real
// ship cycle, and ONLY for the two cases gap-action-resolver.js itself
// already restricts to (requiresFutureInfrastructure, landing-page MANUAL
// tier). Explicitly opt-in and OFF by default: with this unset, neither
// branch below changes at all — same eligibility, same blockedReason, same
// routing, zero decision-engine calls, zero added cost or latency to the
// Monday ship cycle. This is annotation only, never routing: it enriches
// what a human sees on an already-blocked/already-manual recommendation,
// it never ships anything gapDraftEligibility didn't already decide to
// create, and a decision-engine failure here is swallowed (try/catch) so a
// down LLM provider can never break gap shipping.
const DECISION_ENGINE_GAP_ANNOTATIONS = process.env.DECISION_ENGINE_GAP_ANNOTATIONS === 'true';

async function decisionEngineAnnotation(gap, siteId) {
  if (!DECISION_ENGINE_GAP_ANNOTATIONS) return null;
  try {
    const { decision } = await gapActionResolver.resolveGapAction(gap, siteId);
    return decision;
  } catch (err) {
    console.warn(`[analyst-seo-mapping] decision-engine annotation failed for gap ${gap.id}: ${err.message}`);
    return null;
  }
}

// Daily ceiling for THIS pipeline. It had none at all until now, and that was
// a real hole in the platform's shipping limits rather than a deliberate
// exemption: auto-remediation.js caps itself by counting drafts with
// source='auto-remediation' (countDraftsBySourceToday), and job.js's
// platform-wide AUTO_REMEDIATION_GLOBAL_DAILY_CEILING counts the same source
// — so every draft opened here was invisible to both, and a single Monday
// ship cycle could open unbounded PRs no limit ever saw. The per-gap evidence
// gates above (two observations, non-decreasing demand, one-week-old) bound
// WHICH gaps qualify, but nothing bounded HOW MANY shipped in one pass.
//
// 20/day matches the analyst allocation auto-remediation.js already reserves
// for evidence-driven work (its ANALYST_MAX), so the two analyst-side lanes
// carry the same daily weight rather than one being implicitly unlimited.
// Over-cap gaps are NOT dropped: they stay 'pending_review' (the status
// change below only happens for gaps this pass actually ships), so the next
// run reconsiders them with their evidence intact — carried forward, exactly
// like auto-remediation's own over-budget candidates.
const CONTENT_GAP_DAILY_MAX = Number(process.env.ANALYST_CONTENT_GAP_DAILY_MAX || 20);

// Net-new blog topics are ranked by REAL search volume and thinned to this
// pool before anything else applies — the daily/weekly caps below answer
// "how much", this answers "which ones, when there's more demand evidence
// than there is publishing capacity". search_volume is only ever real
// (keyword-demand.js never fabricates one for an LLM-guessed gap), so an
// LLM-guessed topic sorts to the back of the pool rather than being dropped
// outright — it can still ship once nothing with measured demand outranks it.
const MAX_BLOG_TOPIC_POOL = 5;

// blog-outline already has a publishing cadence (ship-pacing.js's
// blog_min_gap_days) enforced on auto-remediation.js's daily sweep of
// already-open recommendations. This pipeline never goes through that sweep
// — it creates AND ships a recommendation in the same call
// (createActionCenterRecommendationForGap) — so without its own check here a
// single Monday run could ship several blog-outline drafts at once, the
// exact "several years' worth of blog posts in one run" class of bug
// ship-pacing.js's own header comment describes for a different path. Reused
// from PACED_GENERATORS rather than re-declared, so the two enforcement
// points can't drift on the gap length or the per-site override column.
const BLOG_PACING = PACED_GENERATORS.find((p) => p.generatorId === 'blog-outline');

// On-page keyword updates (a gap matching an EXISTING page, drafted as an faq
// addition — see gapDraftEligibility) had no cadence gate at all until now,
// only the shared CONTENT_GAP_DAILY_MAX above. Capped to 10/week so they
// batch on a predictable weekly rhythm instead of shipping immediately
// whenever a gap happens to qualify.
const FAQ_WEEKLY_MAX = 10;

export async function qualifyAndShipContentGaps(siteId, site, { dryRun = false, now = new Date() } = {}) {
  const resolvedSite = site || await getSiteById(siteId);
  const gaps = await getKeywordGaps(siteId, 'pending_review');

  // A gap discovered THIS week is never shippable by this week's own pass.
  // The cycle is "ship what last week's discovery produced, then let this
  // week's discovery start" — an opportunity has to survive at least one full
  // week of evidence-gathering (the Tue–Sun refresh passes) before anyone
  // acts on it, which is also the only way it can reach two observations and
  // two evidence snapshots in the first place.
  //
  // This is enforced here, on the data, rather than left to the fact that the
  // Node ship cron (00:00 UTC Monday) currently happens to fire before the
  // Python discovery collector (03:00 UTC). That ordering is real but
  // incidental — it is two independent schedulers in two languages, and on
  // staging a third entry point (a 22:00 UTC host crontab) runs the same
  // collector again. A same-week gap must be unshippable because of what it
  // is, not because of which job won a race.
  const currentWeek = isoWeekStart(now);
  // Gather window is 2 full weeks, not 1: a gap must have survived two
  // week-boundary crossings of evidence-gathering before it can ship, not
  // just one. Computed as the week-start 14 days before this week's own
  // Monday, so a gap first discovered any day in "two weeks ago"'s ISO week
  // or earlier is eligible; anything discovered in the week right before
  // this one still has to wait one more Monday.
  const twoWeeksAgo = new Date(now);
  twoWeeksAgo.setUTCDate(twoWeeksAgo.getUTCDate() - 14);
  const gatherCutoffWeek = isoWeekStart(twoWeeksAgo);

  const candidates = gaps.filter((gap) =>
    (gap.observation_count || 1) >= 2 &&
    ['direct', 'supporting'].includes(gap.product_relevance) &&
    // A NULL first_discovery_week means a row predating migration 143 whose
    // backfill somehow didn't land; treat it as not-yet-attributable and hold
    // it rather than shipping something whose week we can't establish.
    //
    // Compared as 'YYYY-MM-DD' STRINGS, never as Dates: getKeywordGaps returns
    // this column as ::text precisely so this comparison can't be knocked a day
    // (and therefore a week) out by node-postgres parsing a DATE to local
    // midnight. Both sides are already Monday-normalized, so a plain
    // lexicographic <= is the whole test.
    gap.first_discovery_week != null &&
    gap.first_discovery_week <= gatherCutoffWeek &&
    hasStableOrGrowingDemand(gap)
  );

  // Measured once, before the loop, against drafts THIS pipeline already
  // opened today (its own source, its own lane). A dryRun still reports what
  // it would have been bounded to, so the cap is visible without shipping.
  const spentToday = dryRun ? 0 : await countDraftsBySourceToday(siteId, GAP_DRAFT_SOURCE, resolvedSite?.timezone || 'UTC');
  let remaining = Math.max(0, CONTENT_GAP_DAILY_MAX - spentToday);

  const timezone = resolvedSite?.timezone || 'UTC';

  // Rank this run's blog-outline-eligible candidates by real search volume
  // and keep only the top MAX_BLOG_TOPIC_POOL — computed once, up front, so
  // the main loop below can treat "in the pool" as a plain lookup. A NULL
  // search_volume (LLM-guessed) sorts last (-1), never first.
  const rankedBlogPool = candidates
    .filter((gap) => gapDraftEligibility(gap)?.generatorId === 'blog-outline')
    .sort((a, b) => (b.search_volume ?? -1) - (a.search_volume ?? -1))
    .slice(0, MAX_BLOG_TOPIC_POOL);
  const blogPoolIds = new Set(rankedBlogPool.map((gap) => gap.id));
  // The one slot this run may fill always goes to the pool's highest-volume
  // member, never to whichever pool member the main loop below happens to
  // reach first (candidates are ordered by created_at, not by volume).
  const chosenBlogGapId = rankedBlogPool[0]?.id ?? null;
  const blogGapDays = resolvedSite?.[BLOG_PACING.gapColumn] ?? BLOG_PACING.defaultGapDays;
  // Same dryRun convention as spentToday above: a dry run reports against a
  // fully-open cadence/budget rather than the real, already-spent one.
  const blogOnCooldown = dryRun ? false : await hasRecentDraftOfType(siteId, 'blog-outline', blogGapDays, timezone);

  const faqShippedThisWeek = dryRun ? 0 : await countDraftsBySourceAndTypeThisWeek(siteId, GAP_DRAFT_SOURCE, 'faq', timezone);
  let faqRemainingThisWeek = Math.max(0, FAQ_WEEKLY_MAX - faqShippedThisWeek);

  const results = [];
  for (const gap of candidates) {
    const eligibility = gapDraftEligibility(gap);
    if (!eligibility) { results.push({ gapId: gap.id, topic: gap.topic, qualified: false, reason: 'no-draft-eligibility' }); continue; }

    if (eligibility.generatorId === 'blog-outline') {
      if (!blogPoolIds.has(gap.id)) {
        results.push({ gapId: gap.id, topic: gap.topic, qualified: false, reason: `blog-topic-pool-cap (top ${MAX_BLOG_TOPIC_POOL} by search volume)`, generatorId: eligibility.generatorId, deferred: true });
        continue;
      }
      if (blogOnCooldown) {
        results.push({ gapId: gap.id, topic: gap.topic, qualified: false, reason: `blog-cadence-gap (min ${blogGapDays}d)`, generatorId: eligibility.generatorId, deferred: true });
        continue;
      }
      // Only the pool's single highest-volume member gets this run's one
      // slot — never just whichever pool member the loop reaches first,
      // which follows created_at order, not volume.
      if (gap.id !== chosenBlogGapId) {
        results.push({ gapId: gap.id, topic: gap.topic, qualified: false, reason: 'blog-one-per-run', generatorId: eligibility.generatorId, deferred: true });
        continue;
      }
    }

    if (eligibility.generatorId === 'faq' && faqRemainingThisWeek <= 0) {
      results.push({ gapId: gap.id, topic: gap.topic, qualified: false, reason: `on-page-weekly-cap (max ${FAQ_WEEKLY_MAX}/week)`, generatorId: eligibility.generatorId, deferred: true });
      continue;
    }

    // LANDING PAGES ARE NEVER AUTO-APPROVED HERE, no matter how strong the
    // evidence — a dedicated product/use-case page is a bigger commitment
    // than a blog post, and this loop's own auto-approval (below) was
    // silently making that call for every commercial/transactional,
    // directly-relevant gap with no human ever asked. riskTierForGenerator
    // already keeps landing-page 'manual' so no PR can ship without a human
    // clicking through Action Center — but by the time it gets there the
    // gap is buried among everything else, and the actual "should this
    // become a real page" question was already answered, silently, right
    // here. The gap now stays 'pending_review' — visible on the Analyst
    // page's review queue with the "landing page" shape already labeled —
    // until a human explicitly approves it via PUT .../gaps/:gapId. Nothing
    // else about the candidate's evidence changes; only landing-page's
    // routing is held back.
    if (eligibility.generatorId === 'landing-page') {
      // Annotation only, same as the requiresFutureInfrastructure branch
      // above — logged on this run's result for whoever reviews the ship
      // cycle output; does not change riskTier, does not change the
      // pending_review status, does not let a landing page through without
      // the human click-through described in the comment above.
      const decision = await decisionEngineAnnotation(gap, siteId);
      results.push({
        gapId: gap.id, topic: gap.topic, qualified: false, reason: 'landing-page-needs-human-approval',
        generatorId: eligibility.generatorId, ...(decision ? { decisionEngineContext: decision } : {}),
      });
      continue;
    }

    if (dryRun) {
      results.push({ gapId: gap.id, topic: gap.topic, qualified: true, generatorId: eligibility.generatorId, dryRun: true });
      continue;
    }

    // Budget checked HERE, after every cheap disqualification above, so a
    // pass full of non-eligible or landing-page gaps doesn't burn budget it
    // never spent. Deferred gaps keep status 'pending_review' (the approve
    // below is what would have moved them), so nothing is lost — the next
    // run picks them up with their evidence and week attribution unchanged.
    if (remaining <= 0) {
      results.push({ gapId: gap.id, topic: gap.topic, qualified: false, reason: 'daily-cap-reached', generatorId: eligibility.generatorId, deferred: true });
      continue;
    }

    // Same order as the human-approval PUT route (server/routes/keywords.js):
    // persist the status change first, then hand the FRESH row (not the
    // pre-fetch snapshot) to createActionCenterRecommendationForGap, so it
    // never operates on stale field values.
    const updated = await updateKeywordGapStatus(siteId, gap.id, 'approved');
    const outcome = await createActionCenterRecommendationForGap(siteId, updated || gap);
    remaining -= 1;
    if (eligibility.generatorId === 'faq') faqRemainingThisWeek -= 1;
    results.push({ gapId: gap.id, topic: gap.topic, qualified: true, generatorId: eligibility.generatorId, ...outcome });
  }

  return {
    siteId: resolvedSite?.id ?? siteId, pending: gaps.length, candidates: candidates.length,
    shipped: results.filter((r) => r.qualified && !dryRun).length,
    deferred: results.filter((r) => r.deferred).length,
    dailyLimit: CONTENT_GAP_DAILY_MAX, spentToday,
    blogTopicPoolMax: MAX_BLOG_TOPIC_POOL, blogGapDays, blogOnCooldown,
    faqWeeklyMax: FAQ_WEEKLY_MAX, faqShippedThisWeek,
    dryRun, results,
  };
}

function analystReason(insight, predicted) {
  const e = insight.evidence || {};
  const detail = [
    typeof e.pct_change === 'number' ? `${Math.round(e.pct_change)}% change` : null,
    e.direction ? `direction ${e.direction}` : null,
    insight.period_start ? `observed from ${insight.period_start}` : null,
  ].filter(Boolean).join(', ');
  const lead = predicted
    ? `The nightly forecast projects ${insight.metric_key} declining for this page before it shows up in reporting`
    : `The nightly analysis found a real ${insight.metric_key} decline on this page`;
  return detail ? `${lead} (${detail}).` : `${lead}.`;
}

// Strategic Product Topic Map (product-visibility growth objective, Phase
// 3) — Product → capability → the keyword clusters/gaps that relate to it,
// with real visibility numbers. Deliberately a READ-TIME aggregation over
// product_capabilities/keyword_clusters/keyword_gaps rather than a new
// persisted hierarchy table: those three tables are each independently
// written by their own process (a human via the capabilities form,
// clustering.py's nightly run, this file's own approval-time classifier),
// so a synced copy would just be a fourth thing that can drift from the
// sources it's supposed to summarize. This function IS the hierarchy view,
// computed fresh every call — cheap (three already-indexed per-site
// queries, no LLM), so there's no caching problem this trades away.
//
// Association to a capability reuses the same word-overlap heuristic as
// findExistingPageMatch above rather than a stored link, for the same
// reason: clusters/gaps already carry their own real topic text, and a
// capability's name/description IS the thing to match against — there is
// no separate identity to keep in sync.
// Generic SaaS/product-marketing words that appear in almost every AI/tech
// keyword regardless of subject ("agentic as a service pricing", "AI
// software services in Nepal") — excluded from the match set so a topic
// doesn't get credited to a capability on the strength of "software" alone.
// Verified against real data: without this, "CRM Software" matched 26 of
// Zunkiree's 111 gaps, most of them generic AI/agentic topics that only
// share the word "software".
const GENERIC_PRODUCT_WORDS = new Set([
  'software', 'service', 'services', 'solution', 'solutions', 'platform', 'platforms',
  'system', 'systems', 'tool', 'tools', 'management', 'provider', 'providers', 'company', 'companies',
]);

// Exported for analyst-product-mapping.js — the per-page/per-topic product
// mapping the fusion engine needs is the same word-overlap judgment
// buildProductTopicMap already makes for clusters/gaps, just applied to a
// single piece of text (a declining page's top query, a growth
// opportunity's query) instead of every cluster/gap on the site at once.
export function relatesToCapability(text, capability) {
  const words = significantWords(text);
  const capWords = new Set([
    ...significantWords(capability.name),
    ...significantWords(capability.category || ''),
    ...(capability.industries || []).flatMap(significantWords),
  ].filter((w) => !GENERIC_PRODUCT_WORDS.has(w)));
  return words.some((w) => capWords.has(w));
}

export async function buildProductTopicMap(siteId) {
  const [capabilities, clusters, gaps] = await Promise.all([
    getProductCapabilities(siteId, 'verified'),
    getKeywordClusters(siteId),
    getKeywordGaps(siteId),
  ]);

  const matchedClusterNames = new Set();
  const matchedGapIds = new Set();

  const nodes = await Promise.all(capabilities.map(async (capability) => {
    const relatedClusters = clusters.filter((c) => relatesToCapability(c.cluster_name, capability));
    const relatedGaps = gaps.filter((g) => relatesToCapability(g.topic, capability));
    relatedClusters.forEach((c) => matchedClusterNames.add(c.cluster_name));
    relatedGaps.forEach((g) => matchedGapIds.add(g.id));

    const impressions = relatedClusters.map((c) => Number(c.avg_impressions) || 0);
    const positions = relatedClusters.map((c) => Number(c.avg_position)).filter((p) => Number.isFinite(p));

    const visibility = {
      avgImpressions: impressions.length ? Math.round(impressions.reduce((a, b) => a + b, 0) / impressions.length) : null,
      avgPosition: positions.length ? Math.round((positions.reduce((a, b) => a + b, 0) / positions.length) * 10) / 10 : null,
      openGapCount: relatedGaps.filter((g) => g.status === 'pending_review').length,
      approvedGapCount: relatedGaps.filter((g) => g.status === 'approved').length,
    };

    // Trend (Phase 5, migration 114) — the live visibility just computed
    // above vs. the most recent STORED snapshot (typically ~14 days old,
    // written by the cron in server/cron.js), not a second live
    // computation. null when no snapshot has run yet for this capability
    // (brand new, or the cron hasn't fired since it was added) — shown as
    // "not enough history" rather than a fabricated 0% change.
    const [priorSnapshot] = await getRecentCapabilityVisibilitySnapshots(siteId, capability.id, 1).catch(() => []);
    const trend = priorSnapshot && priorSnapshot.avg_impressions != null && visibility.avgImpressions != null
      ? {
          impressionsPctChange: priorSnapshot.avg_impressions > 0
            ? Math.round(((visibility.avgImpressions - priorSnapshot.avg_impressions) / priorSnapshot.avg_impressions) * 1000) / 10
            : null,
          since: priorSnapshot.created_at,
        }
      : null;

    return { capability, clusters: relatedClusters, gaps: relatedGaps, visibility, trend };
  }));

  // Everything that never matched a verified capability — real signal in
  // its own right: a large unmapped bucket means either the capability list
  // is incomplete, or the discovery agents are surfacing off-product topics
  // (the "agentic as a service" vs. booking-engine mismatch this whole
  // layer exists to make visible).
  const unmapped = {
    clusters: clusters.filter((c) => !matchedClusterNames.has(c.cluster_name)),
    gaps: gaps.filter((g) => !matchedGapIds.has(g.id)),
  };

  return { capabilities: nodes, unmapped };
}

// Writes one row per verified capability, recording buildProductTopicMap's
// CURRENT visibility numbers as history for the NEXT call to diff against
// (see the trend computation above). Idempotent in effect if run twice in a
// short window (each call just adds another data point), but intended to
// run once per clustering cycle via the cron job below — running it more
// often doesn't break anything, it just wouldn't reflect any new data
// yet, since clusters/gaps only refresh every 14 days themselves.
export async function snapshotCapabilityVisibility(siteId) {
  const map = await buildProductTopicMap(siteId);
  for (const node of map.capabilities) {
    await recordCapabilityVisibilitySnapshot(siteId, node.capability.id, {
      avgImpressions: node.visibility.avgImpressions,
      avgPosition: node.visibility.avgPosition,
      openGapCount: node.visibility.openGapCount,
      approvedGapCount: node.visibility.approvedGapCount,
    });
  }
  return { siteId, capabilitiesSnapshotted: map.capabilities.length };
}

export async function snapshotCapabilityVisibilityForAllSites() {
  const { listConnectedSites } = await import('../../job.js');
  const sites = await listConnectedSites();
  const results = [];
  for (const site of sites) {
    try {
      const result = await snapshotCapabilityVisibility(site.id);
      results.push({ siteId: site.id, status: 'ok', ...result });
    } catch (err) {
      console.error(`[analyst-seo-mapping] capability visibility snapshot for site ${site.id} "${site.name}" failed:`, err.message);
      results.push({ siteId: site.id, status: 'error' });
    }
  }
  return results;
}
