import KpiStrip from './layout/KpiStrip.jsx';

// Compact top-of-page score strip for AI Growth: Overall (Website Health),
// SEO (Authority Score), AEO (AI-visibility readiness), GEO (geo-audit).
// Each value is a real, independently-computed 0-100 number — the same
// no-fabrication discipline as the rest of the product. All four now arrive
// via the Command Center data payload (data.geoAudit — see command-center.js);
// GEO used to do its own separate draft fetch here, bypassing the shared
// agent_runs snapshot every other tile reads.

// Caption under the value: the tile's own one-liner, or a "no data" note when
// that agent hasn't produced a score.
function captionFor(sublabel, meta) {
  const note = meta?.hasRun === false ? 'Not run yet'
    : meta?.status === 'insufficient-data' ? 'No data yet'
    : meta?.status && meta.status !== 'ok' ? 'Error'
    : null;
  return note ? `${sublabel} · ${note}` : sublabel;
}

const scoreValue = (score) => (typeof score === 'number'
  ? <>{score}<span className="text-sm text-faint font-normal ml-0.5">/100</span></>
  : '—');

export default function GrowthScores({ data, loading }) {
  const healthTrend = data?.health?.trendWeek;
  const healthDelta = healthTrend != null && healthTrend !== 0
    ? { text: `${healthTrend > 0 ? '+' : '−'}${Math.abs(healthTrend)} pts`, tone: healthTrend > 0 ? 'good' : 'bad' }
    : undefined;

  const items = [
    { label: 'Overall', value: scoreValue(data?.health?.score), delta: healthDelta, sub: 'Weighted across all agents' },
    { label: 'SEO', value: scoreValue(data?.authority?.score), sub: captionFor('Backlink authority', data?.authorityMeta) },
    { label: 'AEO', value: scoreValue(data?.aiVisibility?.score), sub: captionFor('AI visibility readiness', data?.aiVisibilityMeta) },
    { label: 'GEO', value: scoreValue(data?.geoAudit?.score), sub: captionFor('Generative engine visibility', data?.geoAuditMeta) },
  ];

  return <KpiStrip items={items} loading={loading} />;
}
