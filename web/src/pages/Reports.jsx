import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import StatCard from '../components/StatCard.jsx';
import PerformanceTrendCard from '../components/PerformanceTrendCard.jsx';
import MoversList from '../components/MoversList.jsx';
import ExecutiveSummaryPanel from '../components/ExecutiveSummaryPanel.jsx';
import AgentFindingCard from '../components/AgentFindingCard.jsx';
import RecommendationCard from '../components/RecommendationCard.jsx';
import ReportHistoryRail from '../components/ReportHistoryRail.jsx';

const fmtInt = (v) => Number(v).toLocaleString();
const fmtFloat = (v) => Number(v).toFixed(1);

const PERIODS = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// /report-summary's real comparison window per tab (server/routes/metrics.js:
// daily compares vs yesterday, weekly/monthly vs the immediately preceding
// week/month) — describes that real window instead of a hardcoded "last week,"
// which was wrong for the daily and monthly tabs.
const MOVER_COMPARISON_LABEL = { daily: 'yesterday', weekly: 'the prior week', monthly: 'the prior month' };

function periodLabel(data) {
  if (!data) return '';
  if (data.period === 'daily') return data.date || '';
  if (data.period === 'weekly') return data.start && data.end ? `${data.start} – ${data.end}` : '';
  if (data.period === 'monthly' && data.ym) {
    const [y, m] = data.ym.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
  }
  return '';
}

export default function Reports({ siteId }) {
  const [period, setPeriod] = useState('daily');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Page-level, not period-scoped — agent findings/recommendations aren't
  // tied to a Daily/Weekly/Monthly tab, so fetched once per site, not per tab.
  const [insights, setInsights] = useState(null);

  useEffect(() => {
    if (!siteId) return;
    setLoading(true);
    setError(false);
    api.reportSummary(siteId, period)
      .then(setData)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [siteId, period]);

  useEffect(() => {
    if (!siteId) return;
    api.reportInsights(siteId).then(setInsights).catch(() => setInsights(null));
  }, [siteId]);

  const m = data?.metrics;
  const findings = insights?.agentFindings || [];
  const recommendations = insights?.recommendations || [];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6 font-sans">
      <PageHeader title="Reports" subtitle="Your AI Executive Briefing" icon="🗒️"
        right={
          <div className="flex items-center gap-2">
            {data?.docUrl && (
              <a href={data.docUrl} target="_blank" rel="noreferrer"
                className="text-xs font-semibold px-3.5 py-2 rounded-lg text-white transition-colors"
                style={{ background: '#6C63FF' }}>
                View Full Google Doc ↗
              </a>
            )}
            <button type="button" disabled title="Coming soon"
              className="text-xs font-semibold px-3.5 py-2 rounded-lg text-slate-400 bg-slate-100 cursor-not-allowed">
              Export PDF
            </button>
          </div>
        } />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex bg-slate-100/80 p-1 rounded-2xl border border-slate-200/30 w-fit">
          {PERIODS.map((p) => (
            <button key={p.key} onClick={() => setPeriod(p.key)}
              className={`text-sm px-4 py-1.5 font-semibold rounded-xl transition ${
                period === p.key
                  ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/10'
                  : 'text-slate-600 hover:bg-white/50 hover:text-slate-800'
              }`}>
              {p.label}
            </button>
          ))}
        </div>
        {!loading && data && <p className="text-[11px] text-slate-400">{periodLabel(data)}</p>}
      </div>

      {error ? (
        <div className="card p-6 text-sm text-slate-500 text-center">Unable to load this report right now.</div>
      ) : (
        <>
          {/* source/generatedAt are deliberately omitted — /report-summary
              never actually returns either (only Command Center's route
              does), so passing them here would always be null/false and
              imply a freshness timestamp this page doesn't really have. */}
          <ExecutiveSummaryPanel text={data?.narrative} />

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <StatCard label="Clicks" icon="🖱" color="#8b5cf6" value={m?.clicks} format={fmtInt} loading={loading} />
            <StatCard label="Impressions" icon="👁" color="#6C63FF" value={m?.impressions} format={fmtInt} loading={loading} />
            <StatCard label="Avg position" hint="lower is better" icon="🏅" color="#f59e0b"
              value={m?.position} lowerIsBetter format={fmtFloat} loading={loading} />
            <StatCard label="Users" icon="👥" color="#10b981" value={m?.users} format={fmtInt} loading={loading} />
            <StatCard label="Sessions" icon="⏱" color="#14b8a6" value={m?.sessions} format={fmtInt} loading={loading} />
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <PerformanceTrendCard series={data?.series} loading={loading} />
            </div>
            <ReportHistoryRail history={data?.history} />
          </div>

          {!loading && data?.movers && (data.movers.gainers.length > 0 || data.movers.droppers.length > 0) && (
            <MoversList gainers={data.movers.gainers} droppers={data.movers.droppers} comparisonLabel={MOVER_COMPARISON_LABEL[period]} />
          )}

          {findings.length > 0 && (
            <div>
              <h2 className="text-[15px] font-bold text-slate-900 mb-3">AI Agent Findings</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {findings.map((f) => (
                  <AgentFindingCard key={f.agentId} category={f.category} name={f.name}
                    stat={f.stat} headline={f.headline} narrative={f.narrative} />
                ))}
              </div>
            </div>
          )}

          {recommendations.length > 0 && (
            <div>
              <h2 className="text-[15px] font-bold text-slate-900 mb-3">Priority Recommendations</h2>
              <div className="space-y-2.5">
                {recommendations.map((r) => (
                  <RecommendationCard key={r.id} title={r.title} reason={r.reason}
                    impact={r.impact} effort={r.effort} category={r.category} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
