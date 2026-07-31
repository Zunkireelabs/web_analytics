import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import AnalystTrendCard from '../components/AnalystTrendCard.jsx';
import AnalystInsightCard from '../components/AnalystInsightCard.jsx';
import AnalystCopilotDrawer from '../components/AnalystCopilotDrawer.jsx';
import { LineChart, Clock, ListChecks, Sparkles, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react';

function formatValue(value, unit) {
  if (value == null) return '—';
  if (unit === 'ratio') return `${(value * 100).toFixed(1)}%`;
  if (unit === 'seconds') return `${Math.round(value)}s`;
  if (unit === 'rank' || unit === 'score_0_100') return (Math.round(value * 10) / 10).toString();
  return Math.round(value).toLocaleString();
}

function KpiTile({ metric }) {
  const wow = metric.period_stats?.wow;
  const up = wow?.pct_change > 0;
  const flat = !wow || wow.pct_change === 0;
  return (
    <div className="card p-4 flex flex-col gap-1.5">
      <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 truncate">{metric.display_name}</span>
      <span className="text-xl font-extrabold text-slate-900 tracking-tight">{formatValue(metric.latest_value, metric.unit)}</span>
      {wow?.pct_change != null && (
        <span className={`inline-flex items-center gap-1 text-[10px] font-bold w-fit ${
          flat ? 'text-slate-400' : up ? 'text-emerald-600' : 'text-rose-600'
        }`}>
          {!flat && (up ? <TrendingUp size={11} /> : <TrendingDown size={11} />)}
          {wow.pct_change > 0 ? '+' : ''}{Math.round(wow.pct_change * 10) / 10}% WoW
        </span>
      )}
    </div>
  );
}

function insightKey(i) {
  return `${i.metric_key}-${i.insight_type}-${i.period_start}`;
}

function InsightGroup({ title, icon: Icon, tint, insights, metricLabel, onResolve, resolvingId, emptyText }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Icon size={14} style={{ color: tint }} />
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-600">{title}</h3>
        <span className="text-[10px] font-bold text-slate-400">({insights.length})</span>
      </div>
      {insights.length === 0 ? (
        <div className="text-xs font-medium text-slate-400 bg-slate-50/60 border border-slate-150 rounded-2xl p-4">{emptyText}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {insights.map((i) => (
            <AnalystInsightCard
              key={insightKey(i)}
              insight={i}
              metricLabel={metricLabel(i.metric_key)}
              onResolve={onResolve}
              resolving={resolvingId === i.recommendation_id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AnalystBody({ clientId }) {
  const [dashboard, setDashboard] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [selectedMetricKey, setSelectedMetricKey] = useState(null);
  const [resolvingId, setResolvingId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const load = () => {
    api.analyst.dashboard(clientId)
      .then((d) => {
        setDashboard(d);
        const firstMetric = Object.values(d.groups).flat()[0];
        setSelectedMetricKey((prev) => prev || firstMetric?.metric_key || null);
      })
      .catch((e) => setError(e.message || 'Failed to load dashboard'));
  };

  useEffect(() => { load(); }, [clientId]);

  if (error) {
    return (
      <div className="text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-2xl p-4 flex items-center gap-2">
        <AlertTriangle size={14} className="text-rose-500 shrink-0" /> {error}
      </div>
    );
  }
  if (!dashboard) {
    return <div className="py-24 text-center text-sm text-slate-400 animate-pulse font-medium">Loading client analysis…</div>;
  }

  const allMetrics = Object.values(dashboard.groups).flat();
  const metricLabel = (key) => allMetrics.find((m) => m.metric_key === key)?.display_name || key;
  const earlyWarnings = dashboard.insights.filter((i) => i.insight_type === 'forecast_risk');
  const whatChanged = dashboard.insights.filter((i) => i.insight_type !== 'forecast_risk');

  const resolve = async (insight) => {
    if (!insight.recommendation_id) return;
    setResolvingId(insight.recommendation_id);
    try {
      await api.analyst.resolveRecommendation(clientId, insight.recommendation_id);
      load(); // dashboard.py already filters resolved recommendations' insights out
    } catch (e) {
      setError(e.message || 'Failed to resolve');
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <div className="space-y-8">
      {dashboard.last_ingested_at && (
        <p className="text-[10px] font-bold text-slate-400 -mt-2">
          Last ingested {new Date(dashboard.last_ingested_at).toLocaleString()}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {allMetrics.slice(0, 8).map((m) => <KpiTile key={m.metric_key} metric={m} />)}
      </div>

      {selectedMetricKey && (
        <AnalystTrendCard
          clientId={clientId}
          metrics={allMetrics}
          selectedMetricKey={selectedMetricKey}
          onSelectMetric={setSelectedMetricKey}
        />
      )}

      <InsightGroup
        title="Early Warning — predicted, hasn't happened yet"
        icon={Clock}
        tint="#8b5cf6"
        insights={earlyWarnings}
        metricLabel={metricLabel}
        onResolve={resolve}
        resolvingId={resolvingId}
        emptyText="No forecasted declines right now."
      />

      <InsightGroup
        title="What Changed"
        icon={ListChecks}
        tint="#ea580c"
        insights={whatChanged}
        metricLabel={metricLabel}
        onResolve={resolve}
        resolvingId={resolvingId}
        emptyText="No anomalies, trend shifts, or milestones to review."
      />

      {!drawerOpen && (
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="fixed bottom-6 right-6 z-30 flex items-center gap-2 text-xs font-black uppercase tracking-wider text-white px-5 py-3.5 rounded-2xl shadow-lg hover:scale-[1.03] active:scale-[0.98] transition cursor-pointer"
          style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)', boxShadow: '0 12px 28px -8px rgba(108,99,255,0.45)' }}
        >
          <Sparkles size={14} /> Ask deeper
        </button>
      )}
      <AnalystCopilotDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} clientId={clientId} />
    </div>
  );
}

export default function Analyst() {
  const [clients, setClients] = useState(null); // null = loading
  const [clientId, setClientId] = useState(null);

  useEffect(() => {
    api.clients.list().then((list) => {
      // Suspended/deleted tenants: get_active_client on the Python side
      // 403s for a suspended client_id, and there's nothing for staff to
      // analyze on a deleted one — filter here rather than surfacing that
      // as an opaque failed fetch after picking one from the switcher.
      const active = list.filter((c) => c.status === 'active');
      setClients(active);
      if (active.length) setClientId((prev) => prev ?? active[0].id);
    }).catch(() => setClients([]));
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analyst"
        subtitle="Cross-client trend, forecast & root cause"
        icon={<LineChart size={20} />}
        right={
          clients?.length > 1 && (
            <select
              value={clientId || ''}
              onChange={(e) => setClientId(Number(e.target.value))}
              className="text-xs font-bold px-3.5 py-2 rounded-xl border border-slate-200/80 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500"
            >
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )
        }
      />

      {clients === null ? (
        <div className="py-24 text-center text-sm text-slate-400 animate-pulse font-medium">Loading clients…</div>
      ) : clients.length === 0 ? (
        <div className="py-24 text-center text-sm text-slate-400 font-medium">No clients onboarded yet.</div>
      ) : clientId ? (
        // key={clientId}: full remount on client switch, not just a refetch
        // — guarantees no frame renders one client's cards while another
        // client's fetch is in flight, and resets the copilot drawer's
        // frontend-only conversation state (see AnalystCopilotDrawer.jsx).
        <AnalystBody key={clientId} clientId={clientId} />
      ) : null}
    </div>
  );
}
