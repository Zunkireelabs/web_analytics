import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import AnalystExecutiveSummary from '../components/AnalystExecutiveSummary.jsx';
import AnalystIntelligenceCard from '../components/AnalystIntelligenceCard.jsx';
import AnalystTrendCard from '../components/AnalystTrendCard.jsx';
import AnalystDiagnosticsPanel from '../components/AnalystDiagnosticsPanel.jsx';
import AnalystFeatureImportanceChart from '../components/AnalystFeatureImportanceChart.jsx';
import AnalystCorrelationExplorer from '../components/AnalystCorrelationExplorer.jsx';
import AnalystRecommendationPriorityList from '../components/AnalystRecommendationPriorityList.jsx';
import AnalystInsightCard from '../components/AnalystInsightCard.jsx';
import AnalystCopilotDrawer from '../components/AnalystCopilotDrawer.jsx';
import AnalystMetricNavigator from '../components/AnalystMetricNavigator.jsx';
import AnalystAiAnalystCard from '../components/AnalystAiAnalystCard.jsx';
import AnalystInvestigationTimeline from '../components/AnalystInvestigationTimeline.jsx';
import { LineChart, Clock, ListChecks, Sparkles, AlertTriangle } from 'lucide-react';

function InsightGroup({
  title, icon: Icon, tint, insights, metricFor, clientId, onResolve, resolvingId, onDismiss, dismissingId, onAnalyzeFurther, emptyText,
}) {
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
              key={i.id}
              insight={i}
              metric={metricFor(i.metric_key)}
              clientId={clientId}
              onResolve={onResolve}
              resolving={resolvingId === i.recommendation_id}
              onDismiss={onDismiss}
              dismissing={dismissingId === i.recommendation_id}
              onAnalyzeFurther={() => onAnalyzeFurther(i.metric_key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SectionHeader({ icon: Icon, iconColor, title, subtitle }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <Icon size={14} style={{ color: iconColor }} />
      <div>
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-600">{title}</h3>
        {subtitle && <p className="text-[10px] font-medium text-slate-400 -mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

function AnalystBody({ clientId }) {
  const [dashboard, setDashboard] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [selectedMetricKey, setSelectedMetricKey] = useState(null);
  const [resolvingId, setResolvingId] = useState(null);
  const [dismissingId, setDismissingId] = useState(null);
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

  // dashboard_group is the outer dict key in dashboard.groups, not a field
  // on the metric card itself — attach it per metric so the navigator can
  // filter/icon by it without a second lookup.
  const allMetrics = Object.entries(dashboard.groups).flatMap(([group, ms]) => ms.map((m) => ({ ...m, dashboard_group: group })));
  const metricFor = (key) => allMetrics.find((m) => m.metric_key === key) || { metric_key: key, display_name: key, unit: null };
  const earlyWarnings = dashboard.insights.filter((i) => i.insight_type === 'forecast_risk');
  const whatChanged = dashboard.insights.filter((i) => i.insight_type !== 'forecast_risk');
  const severityForMetric = (metricKey) => dashboard.insights.find((i) => i.metric_key === metricKey)?.severity;

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

  const dismiss = async (insight) => {
    if (!insight.recommendation_id) return;
    setDismissingId(insight.recommendation_id);
    try {
      await api.analyst.dismissRecommendation(clientId, insight.recommendation_id);
      load(); // dashboard.py filters dismissed recommendations' insights out too
    } catch (e) {
      setError(e.message || 'Failed to dismiss');
    } finally {
      setDismissingId(null);
    }
  };

  // "Analyze Further" — reuses the existing trend-chart metric switcher
  // rather than a separate zoom view; scrolled into view since the chart
  // sits above a potentially long insights list.
  const analyzeMetric = (metricKey) => {
    setSelectedMetricKey(metricKey);
    document.getElementById('analyst-forecast-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="space-y-8">
      {dashboard.last_ingested_at && (
        <p className="text-[10px] font-bold text-slate-400 -mt-2">
          Last ingested {new Date(dashboard.last_ingested_at).toLocaleString()}
        </p>
      )}

      {/* 1. AI Executive Summary — the hero */}
      <AnalystExecutiveSummary clientId={clientId} />

      {/* 2. Predicted Risks — findings that haven't happened yet. This and
          Recommendation Priority right below it are the page's headline
          content: predict, warn early, say what to fix. Everything "what
          already happened" (current value, WoW %, plain trend lines) lives
          in the Core Dashboard (/overview, /insights), not here. */}
      <InsightGroup
        title="Predicted Risks — hasn't happened yet"
        icon={Clock}
        tint="#8b5cf6"
        insights={earlyWarnings}
        metricFor={metricFor}
        clientId={clientId}
        onResolve={resolve}
        resolvingId={resolvingId}
        onDismiss={dismiss}
        dismissingId={dismissingId}
        onAnalyzeFurther={analyzeMetric}
        emptyText="No forecasted declines right now."
      />

      {/* 3. Recommendation Priority — client-wide ranked work queue: what to
          fix first. */}
      <AnalystRecommendationPriorityList clientId={clientId} insights={dashboard.insights} metricFor={metricFor} />

      {/* 4. Investigation Workspace — things that already happened, each
          expanding inline into Root Cause / Repair Strategy / Forecast /
          Projected Impact / Opportunity Score / Deploy (see
          AnalystFindingPipeline). */}
      <InsightGroup
        title="What Changed — Investigation Workspace"
        icon={ListChecks}
        tint="#ea580c"
        insights={whatChanged}
        metricFor={metricFor}
        clientId={clientId}
        onResolve={resolve}
        resolvingId={resolvingId}
        onDismiss={dismiss}
        dismissingId={dismissingId}
        onAnalyzeFurther={analyzeMetric}
        emptyText="No anomalies, trend shifts, or milestones to review."
      />

      {/* 5. Diagnostic Tools — supporting evidence for investigating a
          specific metric, demoted below the action-oriented sections above.
          Metric Navigator replaces the old card grid: pick a metric on the
          left, everything on the right investigates that one metric. */}
      <div id="analyst-forecast-center">
        <SectionHeader icon={Sparkles} iconColor="#6C63FF" title="Diagnostic Tools" subtitle="Select a metric to investigate its forecast, drivers, and statistics" />
        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4 items-start">
          <AnalystMetricNavigator
            metrics={allMetrics}
            insights={dashboard.insights}
            selectedMetricKey={selectedMetricKey}
            onSelect={setSelectedMetricKey}
          />

          {selectedMetricKey && (
            <div className="space-y-6 min-w-0">
              <AnalystIntelligenceCard
                clientId={clientId} metric={metricFor(selectedMetricKey)}
                severity={severityForMetric(selectedMetricKey)}
                selected
                onClick={() => {}}
              />

              <AnalystTrendCard
                clientId={clientId}
                metrics={allMetrics}
                selectedMetricKey={selectedMetricKey}
                onSelectMetric={setSelectedMetricKey}
                insights={dashboard.insights}
              />

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <AnalystAiAnalystCard
                  clientId={clientId}
                  metric={metricFor(selectedMetricKey)}
                  insight={dashboard.insights.find((i) => i.metric_key === selectedMetricKey)}
                />
                <AnalystInvestigationTimeline metric={metricFor(selectedMetricKey)} insights={dashboard.insights} />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <AnalystDiagnosticsPanel clientId={clientId} metricKey={selectedMetricKey} />
                <AnalystFeatureImportanceChart clientId={clientId} targetMetricKey={selectedMetricKey} />
              </div>
            </div>
          )}
        </div>
      </div>

      <AnalystCorrelationExplorer clientId={clientId} />

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
        subtitle="AI Analyst Workspace — forecasting, root cause & autonomous recommendations"
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
