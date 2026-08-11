import { knownDomain } from './site-domain.js';
import { getRelatedQueriesForTopic } from '../../store/data-analyst.js';
import { findOpenRecommendation, insertRecommendation } from '../../store/recommendations.js';
import { recommendationPageKey } from './recommendation-coordinator.js';
import { riskTierForGenerator } from './risk-tiers.js';
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
// is not. Deliberately narrow: only a gsc_* metric with dimension_type
// 'page' (never true today — anomaly/trend-shift detection only runs on
// site/device/country/channel — until data-analyst-agent's
// gsc_page_dimension collector admits a page, see that collector's
// docstring) representing a real decline is eligible for 'expand-content'
// (thin/declining content is the one generator a metric anomaly can point
// at without guessing a schema type or topic). Returns null for anything
// else — callers must treat null as "not eligible," never throw.
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
        riskTier: riskTierForGenerator(eligibility.generatorId),
      })).id;

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
    generatorId: 'expand-content',
    params: { page },
    // Deterministic per (metric, type, period, page) — getDraftByFindingId's
    // idempotency check relies on this being stable across repeated calls
    // for the same finding, not random per request.
    findingId: `analyst:${insight.metric_key}:${insight.insight_type}:${insight.period_start}:${insight.dimension_value}`,
  };
}
