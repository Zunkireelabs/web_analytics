import { callDataAnalystAgent } from '../../lib/data-analyst-client.js';

// Phase 3 of the "one intelligence" consolidation plan (fix/system) —
// adapts the Python data-analyst-agent's Investigation Engine records
// (GET /clients/{client_id}/investigations, data-analyst-agent/app/api/
// investigations.py's _serialize) into the plain Evidence shape
// decision-engine.js consumes: {source, summary, ref, meta}.
//
// Deliberately just an adapter, not a reimplementation: the Investigation
// Engine already does real anti-fabrication reasoning (executive/technical/
// business summaries, an explicit missing-evidence list, forecast_outlook,
// confidence) — this module's only job is making that queryable as Evidence
// alongside Node-side sources, per the confirmed finding that the two
// pipelines currently never exchange findings (only converge on the shared
// `recommendations` table).
//
// Never throws on an unreachable/misconfigured Data Analyst service — same
// contract as provisionAnalystClient (data-analyst-client.js): a separate
// internal service being down must not take evidence-gathering for every
// OTHER source down with it. Callers (decision-evidence.js) rely on this.
export async function fetchInvestigationEvidence(siteId, { status, severity } = {}) {
  let body;
  try {
    body = await callDataAnalystAgent(`/clients/${siteId}/investigations`, {
      query: { status, severity },
    });
  } catch (err) {
    console.warn(`[investigation-evidence] Data Analyst investigations unavailable for site ${siteId}: ${err.message}`);
    return [];
  }

  const investigations = Array.isArray(body?.investigations) ? body.investigations : [];
  return investigations.map(toEvidence);
}

// Exported separately so a caller that already has a raw investigation
// record (e.g. from a webhook or a future push-based path) can reuse the
// exact same mapping without a second HTTP round-trip.
export function toEvidence(inv) {
  const summaryParts = [
    inv.summary,
    inv.root_cause_text ? `Root cause: ${inv.root_cause_text}` : null,
    inv.forecast_outlook ? `Forecast: ${JSON.stringify(inv.forecast_outlook)}` : null,
  ].filter(Boolean);

  return {
    source: 'data-analyst-investigation',
    summary: summaryParts.join(' — ') || `${inv.insight_type} investigation on ${inv.metric_key}`,
    ref: `investigation:${inv.id}`,
    meta: {
      investigationId: inv.id,
      metricKey: inv.metric_key,
      dimensionType: inv.dimension_type,
      dimensionValue: inv.dimension_value,
      insightType: inv.insight_type,
      severity: inv.severity,
      priority: inv.priority,
      status: inv.status,
      confidence: inv.confidence,
      // Passed through verbatim, never re-derived or embellished here — the
      // plan's explicit anti-fabrication requirement (§2: "never invent
      // future values") applies just as much to this adapter as it does to
      // the Investigation Engine itself.
      missingEvidence: inv.missing_evidence || [],
      evidence: inv.evidence || null,
    },
  };
}
