import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import StatCard from '../components/StatCard.jsx';
import PerformanceTrendCard from '../components/PerformanceTrendCard.jsx';
import MoversList from '../components/MoversList.jsx';
import ExecutiveSummaryPanel from '../components/ExecutiveSummaryPanel.jsx';
import AgentFindingsHub from '../components/AgentFindingsHub.jsx';
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
    // Guards against an out-of-order response overwriting the currently
    // selected tab's data — without this, switching Daily -> Weekly ->
    // Monthly quickly could let an earlier tab's slower request resolve
    // LAST and silently win, showing e.g. the Weekly doc/metrics while the
    // Monthly tab is the one actually selected. Same convention already
    // used by Overview.jsx/Insights.jsx/CommandCenter.jsx.
    let cancelled = false;
    setLoading(true);
    setError(false);
    api.reportSummary(siteId, period)
      .then((res) => { if (!cancelled) setData(res); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteId, period]);

  useEffect(() => {
    if (!siteId) return;
    api.reportInsights(siteId).then(setInsights).catch(() => setInsights(null));
  }, [siteId]);

  const m = data?.metrics;
  const findings = insights?.agentFindings || [];
  const recommendations = insights?.recommendations || [];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6 font-sans fade-up relative">

      {/* Decorative Glows */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden no-print">
        <div className="absolute top-0 right-1/4 w-[600px] h-[600px] rounded-full blur-[145px] bg-indigo-500/10 opacity-50 pulse-glow" />
        <div className="absolute bottom-10 left-1/4 w-[500px] h-[500px] rounded-full blur-[125px] bg-purple-500/8 opacity-45 pulse-glow" />
      </div>

      <PageHeader title="Reports" subtitle="Your AI Executive Briefing" icon="🗒️"
        right={
          <div className="flex flex-wrap items-center gap-2">
            {!loading && data?.docUrl && (
              <a href={data.docUrl} target="_blank" rel="noreferrer"
                className="text-xs font-extrabold px-3.5 py-2 rounded-xl text-slate-700 hover:text-slate-900 border border-slate-200/80 bg-white/70 hover:bg-white shadow-sm transition hover:scale-[1.01] active:scale-[0.99] duration-150">
                View Google Doc ↗
              </a>
            )}
            <button 
              type="button" 
              onClick={() => window.print()}
              className="text-xs font-extrabold px-3.5 py-2 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.99] shadow-sm hover:shadow-indigo-500/20 active-pill-shadow hover:brightness-105"
              style={{ background: 'linear-gradient(135deg, #6C63FF, #8b5cf6)' }}
            >
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

          {/* Always 2 cols (even below sm) so 5 cards stacked one-per-row
              doesn't turn into a long mobile scroll. */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">
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
            <div className="space-y-4">
              <h2 className="text-[15px] font-bold text-slate-900">AI Agent Findings</h2>
              <AgentFindingsHub findings={findings} />
            </div>
          )}

          {recommendations.length > 0 && (
            <div id="recommendations-section" className="scroll-mt-6">
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
