import { knownDomain } from './site-domain.js';
import {
  getRelatedQueriesForTopic, getProductCapabilities, setGapClassification, getKeywordClusters, getKeywordGaps,
  recordCapabilityVisibilitySnapshot, getRecentCapabilityVisibilitySnapshots,
} from '../../store/data-analyst.js';
import { listPageInventory } from '../../store/page-inventory.js';
import { analyzePageUrl, hasSufficientGroundingContent } from './page-content.js';
import { findOpenRecommendation, insertRecommendation } from '../../store/recommendations.js';
import { recommendationPageKey } from './recommendation-coordinator.js';
import { riskTierForGenerator } from './risk-tiers.js';
import { getSiteById } from '../../store/read.js';
import { createRecommendationGates } from './recommendation-gates.js';
import { callLLMForJson } from '../../llm.js';
// generateDraft is the exact same shared Generate -> Quality-Gate-Validate
// -> auto-fix -> Validate-again pipeline every other Action Center entry
// point already uses (manual "Generate" click, the MCP tool, seoDraftEligibility
// below) — it already runs the Design Agent stage internally
// (resolveOrCreateComponentTemplate, routes/action-center.js) for any
// generator with a real componentTemplates concept, so calling it here
// gives keyword-gap-approved recommendations the exact same
// Design-fit-before-Action-Center guarantee with no new code of its own.
import { generateDraft } from '../../routes/action-center.js';

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

  const pages = await listPageInventory(siteId, { limit: 500 }).catch(() => []);
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

// Turns an approved keyword gap into a real, actionable Action Center
// recommendation — Gate 1 only ("we should act on this"). It just queues a
// recommendation row; drafting, validation, PR, and the human merge
// approval (Gate 2) all still go through the Action Center's own existing,
// untouched flow (server/routes/action-center.js). Shared by both entry
// points a gap can be approved from — the Analyst page's HTTP route
// (server/routes/keywords.js) and the 'update_keyword_gap_status' MCP tool
// (mcp-server/tools/ai-actions.js) — so approval behaves identically no
// matter which one a caller used.
export async function createActionCenterRecommendationForGap(siteId, gap) {
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
      const boostedPriority = isCommercialIntent && classification.productRelevance === 'direct' ? 'high' : undefined;
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

  const eligibility = gapDraftEligibility(gap);
  if (!eligibility) return { eligible: false };

  const relatedQueries = await getRelatedQueriesForTopic(siteId, gap.topic);
  const evidence = relatedQueries.length
    ? `Related real GSC queries already observed: ${relatedQueries
        .map((q) => `"${q.dim_value}" (${q.impressions} impr, ${q.clicks} clicks, pos ${q.avg_position ?? '—'})`)
        .join('; ')}.`
    : 'No matching real GSC queries found for this topic in the last 90 days — a true zero-coverage gap.';
  const reason = [gap.reason, evidence].filter(Boolean).join(' ');

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
          blockedReason: eligibility.note,
        })).id;
    return {
      eligible: true, created: !existing, recommendationId, draftId: null,
      blockedReason: eligibility.note, requiresFutureInfrastructure: true,
    };
  }

  // faq (existing-page FAQ opportunity) needs {page, query}, not {topic,
  // context} — matches faq.js's actual params contract (server/generators/
  // faq.js), not the topic-only shape blog-outline/landing-page take.
  const params = eligibility.generatorId === 'faq'
    ? { page: eligibility.existingPage, query: gap.topic }
    : { topic: gap.topic, context: eligibility.shapeHint ? `${reason} ${eligibility.shapeHint}` : reason };

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

  const recommendationId = existing
    ? existing.id
    : (await insertRecommendation(siteId, {
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
      })).id;

  // A blocked recommendation must not be drafted: generateDraft would hit the
  // same missing prerequisite and throw, and the catch below would record a
  // draftError that reads like a transient failure rather than the missing
  // configuration it actually is.
  if (gate.blockedReason) {
    return { eligible: true, created: !existing, recommendationId, draftId: null, blockedReason: gate.blockedReason };
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

  return {
    ...generatorForDecliningPage(insight),
    // Deterministic per (metric, type, period, page) — getDraftByFindingId's
    // idempotency check relies on this being stable across repeated calls
    // for the same finding, not random per request.
    findingId: `analyst:${insight.metric_key}:${insight.insight_type}:${insight.period_start}:${insight.dimension_value}`,
    page,
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
    });
    created++;
  }
  return { created, skipped, ineligible, dropped, blocked };
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

function relatesToCapability(text, capability) {
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
