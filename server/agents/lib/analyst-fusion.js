import { knownDomain, hostnameOf } from './site-domain.js';
import { loadDeclines } from './decline-detection.js';
import { buildGrowthOpportunities } from './growth-opportunities.js';
import { getRecentPageInsights } from '../../store/data-analyst.js';
import { checkAnalystFreshness, gate as freshnessGate } from './analyst-freshness.js';
import { loadVerifiedCapabilities, mapPageToProduct, describeMapping } from './analyst-product-mapping.js';
import { getSearchDemandProvider } from '../../providers/search-demand/registry.js';
import { scoreConclusion, dedupeConclusions } from './analyst-scoring.js';
import { upsertAnalystEvidence } from '../../store/analyst-evidence.js';
import { findOpenRecommendation, insertRecommendation } from '../../store/recommendations.js';
import { recommendationPageKey } from './recommendation-coordinator.js';
import { riskTierForGenerator } from './risk-tiers.js';
import { impactFromPriority } from './findings.js';
import { createRecommendationGates } from './recommendation-gates.js';
import { opportunityDraftEligibility } from './analyst-seo-mapping.js';
import { getSiteById } from '../../store/read.js';

// THE EVIDENCE-FUSION ENGINE.
//
// Every prior Analyst path (analyst-seo-mapping.js's syncAnalystInsightsToActionCenter,
// syncGrowthOpportunitiesToActionCenter) turns ONE signal into ONE
// recommendation: one insight row, or one growth-opportunities.js item,
// mapped straight to a generator. That is precisely the failure mode the
// request behind this file calls out — "do not create recommendations
// simply because an anomaly exists". A page can be flagged by an anomaly,
// erode in position, lose impressions, AND be predicted to keep declining —
// four independent signals about the same page — and the old paths would
// have created up to four separate, uncorroborated recommendations (or,
// since findOpenRecommendation merges by exact generatorId, silently
// dropped three of them) instead of one conclusion that says "this is
// strongly corroborated."
//
// This module does not replace those two sync functions or their generator
// choices — it reuses decline-detection.js, growth-opportunities.js,
// opportunityDraftEligibility, riskTierForGenerator, createRecommendationGates
// and insertRecommendation exactly as they already work. What is new is the
// layer ABOVE them: group every real signal by subject, count how many
// independent families agree, gate on freshness, attach a product mapping
// and an (always-marked) external-demand check, write the whole fused
// conclusion to analyst_evidence (migration 141) for audit, and only THEN —
// for conclusions that clear the evidence bar — create or reuse a
// recommendation through the existing, unchanged Action Center pipeline.
//
// A conclusion that does NOT clear the bar is stored with verdict='monitor'
// (real signal, insufficient corroboration) or 'insufficient' and creates NO
// recommendation at all. That is the intended, correct output on a quiet
// night — see the module doc on auto-remediation.js's ANALYST_MAX for why an
// empty analyst lane is the system working, not underperforming.

// Below this many independent corroborating signal families, a decline
// conclusion is real but not yet actionable — recorded as 'monitor'. Two
// families is the minimum the request's own example describes ("position
// deteriorated + impressions weakening + anomaly + forecast" = four; a
// single anomaly alone must never reach 'act').
export const MIN_CORROBORATION_TO_ACT = 2;

function pushIf(list, cond, item) { if (cond) list.push(item); return cond; }

// Groups a declining page's decline-detection reasons (already
// threshold-cleared: position erosion >=1.5 places, impressions >=25% below
// trend, CTR decay >=30%) into named signal families, then adds whatever the
// nightly insight pipeline separately found for the SAME page in the SAME
// direction. Three decline-detection reasons plus three insight types is a
// ceiling of six independent families — matches the request's own example
// almost exactly (position + impressions + anomaly + forecast = 4).
// Exported for testing (analyst-fusion.test.js) — the pure signal-grouping
// logic scenarios 1 and 4 of the acceptance test exercise directly, with no
// database involved.
export function familiesForDecliningPage(decline, pageInsights) {
  const signals = [];
  const families = new Set();

  for (const reason of decline.reasons) {
    if (reason.startsWith('position')) { families.add('position-erosion'); signals.push({ family: 'position-erosion', source: 'gsc_query_page', detail: reason }); }
    else if (reason.startsWith('impressions')) { families.add('impressions-decline'); signals.push({ family: 'impressions-decline', source: 'gsc_query_page', detail: reason }); }
    else if (reason.startsWith('CTR')) { families.add('ctr-decay'); signals.push({ family: 'ctr-decay', source: 'gsc_query_page', detail: reason }); }
  }

  let forecastConfidence = null;
  for (const insight of pageInsights) {
    const e = insight.evidence || {};
    const isDeclineSignal =
      (insight.insight_type === 'anomaly' && e.direction === 'low') ||
      insight.insight_type === 'forecast_risk' ||
      (insight.insight_type === 'trend_shift' && typeof e.pct_change === 'number' && e.pct_change < 0);
    if (!isDeclineSignal) continue;
    families.add(insight.insight_type);
    signals.push({
      family: insight.insight_type, source: 'insights', metricKey: insight.metric_key,
      detail: insight.insight_type === 'forecast_risk'
        ? `forecast projects continued decline (confidence ${e.confidence?.toFixed?.(2) ?? 'n/a'}, ${Math.round(e.pct_projected_change || 0)}% projected change)`
        : insight.insight_type === 'anomaly'
          ? `anomaly detected (${e.method}, score ${e.score?.toFixed?.(2) ?? e.score})`
          : `${Math.round(e.pct_change)}% trend shift`,
      periodStart: insight.period_start,
    });
    if (insight.insight_type === 'forecast_risk' && typeof e.confidence === 'number') {
      forecastConfidence = forecastConfidence == null ? e.confidence : Math.max(forecastConfidence, e.confidence);
    }
  }

  return { families, signals, forecastConfidence };
}

export function generatorForDecliningPage(decline, page) {
  // Same ordering logic as analyst-seo-mapping.js's generatorForDecliningPage
  // (position -> answer-the-query, CTR -> presentation, else -> coverage),
  // applied here to the fused, multi-signal decline rather than one raw
  // insight — kept in sync deliberately rather than imported, since the two
  // read different inputs (one insight vs. one decline-detection result).
  if (decline.reasons.some((r) => r.startsWith('position'))) return { generatorId: 'qa-content', params: { page } };
  if (decline.reasons.some((r) => r.startsWith('CTR'))) return { generatorId: 'meta-title', params: { page } };
  return { generatorId: 'expand-content', params: { page } };
}

function buildNarrative({ page, decline, families, signals, forecastConfidence, mapping, mappingText, verdict, direction, action }) {
  const changeDetail = decline.reasons.join('; ');
  const forecastSignal = signals.find((s) => s.family === 'forecast_risk');
  return {
    observed: `${page} shows: ${changeDetail}.`,
    changed: `${signals.length} independent signal(s) across ${families.size} families moved together on this page in the same direction.`,
    predicted: forecastSignal
      ? `The forecast engine projects the decline to continue (${forecastSignal.detail}).`
      : 'No forecast signal is available for this page; the prediction rests on the measured trend alone.',
    why: `${families.size} independent evidence families corroborate the same conclusion` +
      (forecastConfidence != null ? `, including a forecast at ${(forecastConfidence * 100).toFixed(0)}% confidence` : '') + '.',
    cause: mappingText,
    opportunity: `Impressions already lost: ${decline.impressionsLost}. Impressions at risk if the trend continues: ${decline.impressionsAtRisk}.`,
    action: action ? `${action.generatorId} on ${page}` : 'Monitor — evidence is real but not yet corroborated enough to act autonomously.',
    surface: page,
    measurement: `Re-measure this page's impressions, clicks, average position and CTR for the affected queries ~31 days after the fix ships (fix-impact.js's existing measurement window).`,
  };
}

async function fuseDecliningPages(site, { declines, pageInsights, capabilities, freshness, provider }) {
  const conclusions = [];
  for (const [page, decline] of declines) {
    const primaryDomain = knownDomain(site);
    if (primaryDomain && hostnameOf(page) !== primaryDomain) continue;

    const pageInsightsHere = pageInsights.filter((i) => i.page === page);
    const { families, signals, forecastConfidence } = familiesForDecliningPage(decline, pageInsightsHere);
    const corroboration = families.size;

    const mapping = await mapPageToProduct(site.id, page, capabilities);
    const mappingText = describeMapping(mapping, page);
    const demand = await provider.fetchDemand(page).catch(() => ({ available: false, note: 'provider call failed' }));

    const baseConfidence = Math.min(1, corroboration / 4) * (forecastConfidence != null ? 0.6 + 0.4 * forecastConfidence : 1);
    const confidence = Math.round(baseConfidence * freshness.confidenceMultiplier * 1000) / 1000;

    const clearsEvidenceBar = corroboration >= MIN_CORROBORATION_TO_ACT;
    const gate = freshnessGate(freshness);
    const verdict = !clearsEvidenceBar ? 'monitor' : (gate.allowAutonomous ? 'act' : 'monitor');

    const action = verdict === 'act' ? generatorForDecliningPage(decline, page) : null;
    const impact = decline.impressionsLost + Math.round(decline.impressionsAtRisk * 0.5);
    const urgent = decline.reasons.some((r) => r.startsWith('position'));

    const findingId = `analyst-fusion:decline-risk:${page}`;
    const narrative = buildNarrative({ page, decline, families, signals, forecastConfidence, mapping, mappingText, verdict, direction: 'decline-risk', action });

    const conclusion = {
      subjectType: 'page', subjectKey: page, direction: 'decline-risk', page,
      corroboration, confidence, impact, urgent,
      productRelevance: mapping.relevance, feasible: true,
      generatorId: action?.generatorId || null, params: action?.params || { page },
      findingId, verdict, freshnessPresentation: gate.presentation,
      signals, productMapping: { capability: mapping.capability ? { id: mapping.capability.id, name: mapping.capability.name, category: mapping.capability.category } : null, relevance: mapping.relevance, topQueries: mapping.topQueries, surface: { kind: 'expand-existing-page', page } },
      externalDemand: demand, narrative,
    };
    const { score, factors } = scoreConclusion(conclusion);
    conclusions.push({ ...conclusion, score, scoreFactors: factors });
  }
  return conclusions;
}

async function fuseGrowthOpportunities(site, { opportunities, pageInsights, capabilities, freshness, provider }) {
  const conclusions = [];
  for (const opp of opportunities) {
    // content-gap has its own, richer approval path (LLM relevance
    // classification + real existing-page check) that already runs at
    // approval time via createActionCenterRecommendationForGap /
    // qualifyAndShipContentGaps — fusing it here would duplicate that
    // judgment with a cheaper one. ai-visibility is never produced
    // (growth-opportunities.js's own doc comment — no per-page attribution
    // exists yet).
    if (opp.type === 'content-gap' || opp.type === 'ai-visibility') continue;

    const eligibility = opportunityDraftEligibility(site, opp);
    if (!eligibility) continue; // wrong domain, or no page — same scoping every other path uses

    const pageInsightsHere = opp.page ? pageInsights.filter((i) => i.page === opp.page) : [];
    const positiveCorroboration = pageInsightsHere.some((i) => {
      const e = i.evidence || {};
      return (i.insight_type === 'anomaly' && e.direction === 'high')
        || (i.insight_type === 'trend_shift' && typeof e.pct_change === 'number' && e.pct_change > 0);
    });
    // The opportunity itself is real, threshold-cleared evidence
    // (growth-opportunities.js's MIN_IMPRESSIONS/CTR-ratio/click-drop
    // thresholds) — that is corroboration family #1 on its own. A second,
    // independent nightly-insight signal in the same direction raises it to
    // 2, which is the bar this fusion pass applies uniformly across both
    // directions.
    const corroboration = 1 + (positiveCorroboration ? 1 : 0);

    const mapping = opp.page ? await mapPageToProduct(site.id, opp.page, capabilities) : { capability: null, relevance: 'unmapped', topQueries: [] };
    const mappingText = opp.page ? describeMapping(mapping, opp.page) : 'No existing page to map — this is a net-new coverage opportunity.';
    const demand = await provider.fetchDemand(opp.query || opp.page || '').catch(() => ({ available: false, note: 'provider call failed' }));

    const severityBase = { high: 0.75, medium: 0.55, low: 0.35 }[opp.severity] ?? 0.45;
    const confidence = Math.round(Math.min(1, severityBase + 0.1 * (corroboration - 1)) * freshness.confidenceMultiplier * 1000) / 1000;

    const gate = freshnessGate(freshness);
    // Growth opportunities are lower-risk to surface than a decline-risk
    // autonomous edit — they EXPAND a page rather than diagnosing a fault —
    // so the evidence bar is the opportunity's own real threshold (already
    // corroboration>=1) rather than requiring a second family, but they are
    // still subject to the same freshness gate: a stale pipeline must not
    // autonomously ship an "opportunity" computed over dead data either.
    const verdict = gate.allowAutonomous ? 'act' : 'monitor';

    const findingId = eligibility.findingId.startsWith('growth-opportunity:') ? eligibility.findingId : `growth-opportunity:${opp.type}:${opp.page}:${opp.query || ''}`;
    const narrative = {
      observed: opp.reason,
      changed: opp.trend ? `Clicks moved from ${opp.trend.priorClicks} to ${opp.trend.recentClicks} (${opp.trend.dropPct}%).` : `${opp.impressions} impressions at position #${opp.avgPosition?.toFixed?.(1) ?? opp.avgPosition}.`,
      predicted: 'Continued or accelerated capture of this demand if the recommended surface change ships.',
      why: `${corroboration} corroborating signal(s): the opportunity's own real GSC thresholds` + (positiveCorroboration ? ' plus a matching positive nightly insight on the same page.' : '.'),
      cause: mappingText,
      opportunity: `Estimated opportunity size: ${opp.opportunityScore}.`,
      action: opp.recommendedAction,
      surface: opp.page || opp.query,
      measurement: 'Re-measure impressions, clicks, CTR and average position for the affected query/page ~31 days after the fix ships.',
    };

    const conclusion = {
      subjectType: opp.page ? 'page' : 'query-cluster', subjectKey: opp.page || opp.query, direction: 'growth-opportunity',
      page: opp.page, corroboration, confidence, impact: opp.opportunityScore || 0, urgent: opp.severity === 'high',
      productRelevance: mapping.relevance, feasible: true,
      generatorId: eligibility.generatorId, params: eligibility.params,
      findingId, verdict, freshnessPresentation: gate.presentation,
      signals: [{ family: 'growth-opportunity', source: 'gsc_query_page', detail: opp.reason }, ...(positiveCorroboration ? [{ family: 'positive-insight', source: 'insights', detail: 'matching positive anomaly/trend on the same page' }] : [])],
      productMapping: { capability: mapping.capability ? { id: mapping.capability.id, name: mapping.capability.name, category: mapping.capability.category } : null, relevance: mapping.relevance, topQueries: mapping.topQueries, surface: { kind: opp.page ? 'expand-existing-page' : 'new-landing-page', page: opp.page || null } },
      externalDemand: demand, narrative,
    };
    const { score, factors } = scoreConclusion(conclusion);
    conclusions.push({ ...conclusion, score, scoreFactors: factors });
  }
  return conclusions;
}

// Turns an 'act' conclusion into a real Action Center recommendation via the
// EXACT SAME insert path every other Analyst sync uses — findOpenRecommendation
// for idempotency, createRecommendationGates for the same repo/component/
// soft-404 checks, riskTierForGenerator for the same tier assignment,
// insertRecommendation for the same row shape. Nothing about how a
// recommendation ships is reinvented here.
async function shipConclusion(siteId, gates, conclusion) {
  const page = recommendationPageKey({ generatorId: conclusion.generatorId, params: conclusion.params });
  const existing = await findOpenRecommendation(siteId, page, conclusion.generatorId);
  if (existing) return { recommendationId: existing.id, created: false };

  const gateResult = await gates.evaluate(conclusion.generatorId, conclusion.params).catch(() => ({ drop: null, blockedReason: null }));
  if (gateResult.drop) return { recommendationId: null, created: false, dropped: true };

  const predicted = conclusion.direction === 'decline-risk';
  const rec = await insertRecommendation(siteId, {
    page, recommendationType: conclusion.generatorId,
    issue: `${conclusion.direction === 'decline-risk' ? 'Predicted/observed decline' : 'Growth opportunity'} on ${page} — ${conclusion.corroboration} corroborating signal(s)`,
    reason: [conclusion.narrative.observed, conclusion.narrative.why, conclusion.narrative.cause, `Do now: ${conclusion.narrative.action}.`, `Measure: ${conclusion.narrative.measurement}`].filter(Boolean).join(' '),
    params: conclusion.params,
    findingId: conclusion.findingId,
    detectingAgent: 'analyst-fusion',
    priority: conclusion.direction === 'decline-risk' ? (conclusion.urgent ? 'high' : 'medium') : (conclusion.urgent ? 'high' : 'medium'),
    riskTier: gateResult.blockedReason ? 'manual' : riskTierForGenerator(conclusion.generatorId),
    blockedReason: gateResult.blockedReason,
    confidence: conclusion.confidence,
    expectedImpact: { label: impactFromPriority(predicted ? 'medium' : 'high'), basis: 'estimate', value: null },
  });
  return { recommendationId: rec.id, created: true, blocked: !!gateResult.blockedReason };
}

/**
 * The nightly fused-conclusion pass for one site — combines decline-risk and
 * growth-opportunity signals, scores/dedupes them, gates on freshness,
 * persists every conclusion to analyst_evidence (audit trail even for
 * 'monitor'/'insufficient' verdicts), and ships 'act' verdicts as real
 * Action Center recommendations through the existing pipeline.
 *
 * Never throws to the caller for a single site's normal operation — a
 * missing GSC history or a Python-service hiccup produces a smaller (or
 * empty) result, never a crashed run, matching every other Analyst sync
 * function's posture.
 */
export async function runAnalystFusion(siteId, { site: siteArg } = {}) {
  const site = siteArg || await getSiteById(siteId);
  if (!site) return { conclusions: [], created: 0, monitored: 0, freshness: null };

  const freshness = await checkAnalystFreshness(siteId);

  const [{ declines, siteWide }, pageInsights, capabilities, growth] = await Promise.all([
    loadDeclines(siteId, { timezone: site.timezone || 'UTC' }).catch(() => ({ declines: new Map(), siteWide: null })),
    getRecentPageInsights(siteId).catch(() => []),
    loadVerifiedCapabilities(siteId).catch(() => []),
    buildGrowthOpportunities(siteId).catch(() => ({ opportunities: [] })),
  ]);

  const provider = getSearchDemandProvider();

  const [declineConclusions, growthConclusions] = await Promise.all([
    fuseDecliningPages(site, { declines, pageInsights, capabilities, freshness, provider }),
    fuseGrowthOpportunities(site, { opportunities: growth.opportunities, pageInsights, capabilities, freshness, provider }),
  ]);

  const deduped = dedupeConclusions([...declineConclusions, ...growthConclusions]);

  const gates = createRecommendationGates(siteId, site);
  let created = 0;
  let monitored = 0;
  const results = [];

  for (const conclusion of deduped) {
    let recommendationId = null;
    if (conclusion.verdict === 'act') {
      const shipResult = await shipConclusion(siteId, gates, conclusion);
      recommendationId = shipResult.recommendationId;
      if (shipResult.created) created++;
    } else {
      monitored++;
    }

    await upsertAnalystEvidence(siteId, {
      subjectType: conclusion.subjectType, subjectKey: conclusion.subjectKey, direction: conclusion.direction,
      verdict: conclusion.verdict, corroboration: conclusion.corroboration, confidence: conclusion.confidence,
      score: conclusion.score, scoreFactors: conclusion.scoreFactors, signals: conclusion.signals,
      freshness: { verdict: freshness.verdict, presentation: conclusion.freshnessPresentation, sources: freshness.sources },
      narrative: conclusion.narrative, productMapping: conclusion.productMapping, externalDemand: conclusion.externalDemand,
      recommendationId, findingId: conclusion.findingId,
    }).catch((err) => console.warn(`[analyst-fusion] site ${siteId}: failed to persist evidence for ${conclusion.findingId}: ${err.message}`));

    results.push({ ...conclusion, recommendationId });
  }

  if (freshness.verdict === 'stale') {
    console.warn(`[analyst-fusion] site ${siteId}: inputs are STALE — no autonomous recommendation created this run; every conclusion recorded as 'monitor'. ${freshnessGate(freshness).reason}`);
  }
  console.log(`[analyst-fusion] site ${siteId}: ${deduped.length} conclusion(s) fused (${declineConclusions.length} decline-risk, ${growthConclusions.length} growth-opportunity) — ${created} created, ${monitored} monitored. Freshness: ${freshness.verdict}.`);

  return { conclusions: results, created, monitored, freshness, siteWide };
}
