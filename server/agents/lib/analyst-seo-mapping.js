import { knownDomain } from './site-domain.js';
import { getRelatedQueriesForTopic } from '../../store/data-analyst.js';
import { findOpenRecommendation, insertRecommendation } from '../../store/recommendations.js';
import { recommendationPageKey } from './recommendation-coordinator.js';
import { riskTierForGenerator } from './risk-tiers.js';
import { getSiteById } from '../../store/read.js';
import { createRecommendationGates } from './recommendation-gates.js';
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

// keyword_gaps -> Action Center generator mapping. A gap is by definition a
// topic with zero real existing coverage (agents/clustering.py Step 3), so
// 'expand-content' above (which fetches and expands an EXISTING page) can
// never apply here — 'blog-outline' drafts a brand-new, publication-ready
// article, which is the correct fit for a genuine content gap. Returns null
// only when the gap itself is malformed (no topic) — callers must treat null
// as "not eligible," never throw, same convention as seoDraftEligibility.
export function gapDraftEligibility(gap) {
  if (!gap?.id || !gap?.topic) return null;
  return {
    generatorId: 'blog-outline',
    // Stable per gap id — a re-approval of the same gap (e.g. after an
    // earlier attempt's recommendation was dismissed) reuses the same
    // finding identity rather than looking like a brand-new detection.
    findingId: `keyword-gap:${gap.id}`,
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
  const eligibility = gapDraftEligibility(gap);
  if (!eligibility) return { eligible: false };

  const relatedQueries = await getRelatedQueriesForTopic(siteId, gap.topic);
  const evidence = relatedQueries.length
    ? `Related real GSC queries already observed: ${relatedQueries
        .map((q) => `"${q.dim_value}" (${q.impressions} impr, ${q.clicks} clicks, pos ${q.avg_position ?? '—'})`)
        .join('; ')}.`
    : 'No matching real GSC queries found for this topic in the last 90 days — a true zero-coverage gap.';
  const reason = [gap.reason, evidence].filter(Boolean).join(' ');
  const params = { topic: gap.topic, context: reason };

  const page = recommendationPageKey({ generatorId: eligibility.generatorId, params: { topic: gap.topic } });
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
