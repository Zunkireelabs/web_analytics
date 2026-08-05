import { useEffect, useState, useMemo } from 'react';
import { api } from '../api.js';
import AnalystHeaderOS from '../components/AnalystHeaderOS.jsx';
import AnalystPredictiveHero from '../components/AnalystPredictiveHero.jsx';
import AnalystProactiveActionBoard from '../components/AnalystProactiveActionBoard.jsx';
import AnalystPredictiveStudio from '../components/AnalystPredictiveStudio.jsx';
import AnalystCommandPalette from '../components/AnalystCommandPalette.jsx';
import AnalystCustomizerDrawer from '../components/AnalystCustomizerDrawer.jsx';
import AnalystKeyboardShortcutsModal from '../components/AnalystKeyboardShortcutsModal.jsx';
import AnalystExecutiveSummary from '../components/AnalystExecutiveSummary.jsx';
import AnalystRecommendationPriorityList from '../components/AnalystRecommendationPriorityList.jsx';
import AnalystInvestigationWorkspace from '../components/AnalystInvestigationWorkspace.jsx';
import AnalystMetricNavigator from '../components/AnalystMetricNavigator.jsx';
import AnalystDiagnosticHero from '../components/AnalystDiagnosticHero.jsx';
import AnalystTrendCard from '../components/AnalystTrendCard.jsx';
import AnalystForecastSummaryCard from '../components/AnalystForecastSummaryCard.jsx';
import AnalystAiAnalystCard from '../components/AnalystAiAnalystCard.jsx';
import AnalystInvestigationTimeline from '../components/AnalystInvestigationTimeline.jsx';
import AnalystDiagnosticsPanel from '../components/AnalystDiagnosticsPanel.jsx';
import AnalystFeatureImportanceChart from '../components/AnalystFeatureImportanceChart.jsx';
import AnalystCorrelationExplorer from '../components/AnalystCorrelationExplorer.jsx';
import AnalystKeywordDiscovery from '../components/AnalystKeywordDiscovery.jsx';
import AnalystCopilotDrawer from '../components/AnalystCopilotDrawer.jsx';
import AnalystSkeletonLoader from '../components/AnalystSkeletonLoader.jsx';
import AnalystEmptyState from '../components/AnalystEmptyState.jsx';
import {
  LineChart, ListChecks, Sparkles, AlertTriangle, ArrowUp, ArrowDown, Eye, EyeOff, Activity, Layers, Radar, ShieldCheck, Search,
} from 'lucide-react';

const PRESET_ORDER_MAP = {
  // Prediction-first command center flow: read the future, see the fixes,
  // then dive into the evidence. Keyword Discovery is a standalone research
  // tool (not part of the predictive/investigation flow), so it's appended
  // last in every preset rather than reordered per-preset.
  executive: ['hero', 'fixes', 'summary', 'priorities', 'studio', 'workspace', 'diagnostics', 'correlations', 'keyword-discovery'],
  investigation: ['workspace', 'fixes', 'hero', 'studio', 'summary', 'priorities', 'diagnostics', 'correlations', 'keyword-discovery'],
  growth: ['hero', 'studio', 'diagnostics', 'priorities', 'fixes', 'summary', 'workspace', 'correlations', 'keyword-discovery'],
  copilot: ['hero', 'summary', 'diagnostics', 'workspace', 'fixes', 'priorities', 'studio', 'correlations', 'keyword-discovery'],
};

const DEFAULT_SECTIONS = [
  { id: 'hero', title: 'Prediction Readout', subtitle: 'What the data says is coming next', icon: Radar, iconColor: '#8b5cf6', visible: true },
  { id: 'fixes', title: 'Proactive Fix Board', subtitle: 'Predicted issues with generated fixes', icon: ShieldCheck, iconColor: '#34d399', visible: true },
  { id: 'summary', title: 'AI Executive Summary', subtitle: 'LLM synthesis of current state', icon: Sparkles, iconColor: '#3b82f6', visible: true },
  { id: 'priorities', title: 'Recommendation Priority', subtitle: 'Ranked work queue of predicted actions', icon: ListChecks, iconColor: '#ea580c', visible: true },
  { id: 'studio', title: 'Predictive Intelligence Studio', subtitle: 'Generative traffic modeling & future performance curves', icon: Sparkles, iconColor: '#8b5cf6', visible: true },
  { id: 'workspace', title: 'Investigation Workspace', subtitle: 'Predicted risks and anomalies sorted by severity', icon: Activity, iconColor: '#ef4444', visible: true },
  { id: 'diagnostics', title: 'Diagnostic Tools & Metric Navigator', subtitle: 'Select a metric to investigate trend, forecast & drivers', icon: LineChart, iconColor: '#6366f1', visible: true },
  { id: 'correlations', title: 'Correlation & Driver Explorer', subtitle: 'Cross-metric mathematical relationship explorer', icon: Layers, iconColor: '#10b981', visible: true },
  { id: 'keyword-discovery', title: 'Keyword Discovery', subtitle: 'Semantic clusters, coverage gaps & site profile', icon: Search, iconColor: '#6366f1', visible: true },
];

function SectionShell({ sec, idx, sectionList, handleMoveSection, handleToggleSection, children }) {
  const Icon = sec.icon;
  const visibleCount = sectionList.filter((s) => s.visible).length;
  return (
    <div id={`sec-${sec.id}`} className="space-y-2.5 group/sec scroll-mt-4">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-lg grid place-items-center shrink-0 border"
            style={{ backgroundColor: `${sec.iconColor}14`, borderColor: `${sec.iconColor}28`, color: sec.iconColor }}
          >
            <Icon size={13} />
          </div>
          <div>
            <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-800">{sec.title}</h3>
            {sec.subtitle && (
              <p className="text-[10px] font-medium text-slate-500 -mt-0.5">{sec.subtitle}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover/sec:opacity-100 transition">
          <button
            type="button"
            disabled={idx === 0}
            onClick={() => handleMoveSection(idx, -1)}
            className="p-1 rounded-md bg-slate-200/60 border border-slate-300 text-slate-400 hover:text-slate-900 disabled:opacity-20 transition cursor-pointer"
            title="Move Section Up"
          >
            <ArrowUp size={11} />
          </button>
          <button
            type="button"
            disabled={idx === visibleCount - 1}
            onClick={() => handleMoveSection(idx, 1)}
            className="p-1 rounded-md bg-slate-200/60 border border-slate-300 text-slate-400 hover:text-slate-900 disabled:opacity-20 transition cursor-pointer"
            title="Move Section Down"
          >
            <ArrowDown size={11} />
          </button>
          <button
            type="button"
            onClick={() => handleToggleSection(sec.id)}
            className="p-1 rounded-md bg-slate-200/60 border border-slate-300 text-slate-400 hover:text-rose-600 transition cursor-pointer"
            title="Hide Section"
          >
            <EyeOff size={11} />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

function AnalystBody({ clientId, onSummary }) {
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState(null);
  const [selectedMetricKey, setSelectedMetricKey] = useState(null);
  const [resolvingId, setResolvingId] = useState(null);
  const [dismissingId, setDismissingId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [copilotInitialPrompt, setCopilotInitialPrompt] = useState('');
  const [selectedWorkspaceFindingId, setSelectedWorkspaceFindingId] = useState(null);

  const [preset, setPreset] = useState(() => localStorage.getItem('analyst_preset') || 'executive');
  const [theme, setTheme] = useState(() => localStorage.getItem('analyst_theme') || 'velvet');
  const [density, setDensity] = useState(() => localStorage.getItem('analyst_density') || 'standard');
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [sectionList, setSectionList] = useState(() => {
    const savedOrder = localStorage.getItem('analyst_section_order');
    if (savedOrder) {
      try {
        const orderIds = JSON.parse(savedOrder);
        const rebuilt = orderIds
          .map((id) => DEFAULT_SECTIONS.find((s) => s.id === id))
          .filter(Boolean);
        if (rebuilt.length) return rebuilt;
      } catch (e) {
        // fallback to defaults
      }
    }
    return DEFAULT_SECTIONS;
  });

  const load = () => {
    setIsRefreshing(true);
    api.analyst.dashboard(clientId)
      .then((d) => {
        setDashboard(d);
        const firstMetric = Object.values(d.groups || {}).flat()[0];
        setSelectedMetricKey((prev) => prev || firstMetric?.metric_key || null);
      })
      .catch((e) => setError(e.message || 'Failed to load dashboard'))
      .finally(() => setIsRefreshing(false));
  };

  useEffect(() => { load(); }, [clientId]);

  const handleSelectPreset = (newPreset) => {
    setPreset(newPreset);
    localStorage.setItem('analyst_preset', newPreset);
    const orderIds = PRESET_ORDER_MAP[newPreset] || PRESET_ORDER_MAP.executive;
    const newSections = orderIds
      .map((id) => DEFAULT_SECTIONS.find((s) => s.id === id))
      .filter(Boolean);
    setSectionList(newSections);
    localStorage.setItem('analyst_section_order', JSON.stringify(orderIds));
  };

  const handleSelectTheme = (newTheme) => {
    setTheme(newTheme);
    localStorage.setItem('analyst_theme', newTheme);
  };

  const handleSelectDensity = (newDensity) => {
    setDensity(newDensity);
    localStorage.setItem('analyst_density', newDensity);
  };

  const handleToggleSection = (id) => {
    setSectionList((prev) => prev.map((s) => (s.id === id ? { ...s, visible: !s.visible } : s)));
  };

  const handleMoveSection = (index, direction) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= sectionList.length) return;
    const updated = [...sectionList];
    const [moved] = updated.splice(index, 1);
    updated.splice(targetIndex, 0, moved);
    setSectionList(updated);
    localStorage.setItem('analyst_section_order', JSON.stringify(updated.map((s) => s.id)));
  };

  const handleResetLayout = () => {
    setSectionList(DEFAULT_SECTIONS);
    setPreset('executive');
    setTheme('velvet');
    setDensity('standard');
    localStorage.removeItem('analyst_section_order');
    localStorage.removeItem('analyst_preset');
    localStorage.removeItem('analyst_theme');
    localStorage.removeItem('analyst_density');
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        const map = { '1': 'executive', '2': 'investigation', '3': 'growth', '4': 'copilot' };
        handleSelectPreset(map[e.key]);
      }
      if (e.key === '?' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        setShortcutsModalOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleOpenCopilotWithPrompt = (promptText) => {
    setCopilotInitialPrompt(promptText);
    setDrawerOpen(true);
  };

  const handleNavigateSection = (sectionElementId) => {
    const elem = document.getElementById(sectionElementId);
    if (elem) elem.scrollIntoView({ behavior: 'smooth' });
  };

  if (error) {
    return (
      <div className="an-panel p-5 border-rose-500/30 bg-rose-500/[0.06] text-rose-600 font-semibold text-xs flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle size={16} className="text-rose-600 shrink-0" />
          <span>{error}</span>
        </div>
        <button
          type="button"
          onClick={load}
          className="px-3 py-1 rounded-xl bg-slate-100 border border-rose-400/30 text-rose-600 text-xs font-bold hover:bg-slate-200 transition cursor-pointer"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="space-y-6">
        <AnalystSkeletonLoader variant="hero" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <AnalystSkeletonLoader variant="card" />
          <AnalystSkeletonLoader variant="list" rows={3} />
        </div>
      </div>
    );
  }

  const allMetrics = Object.entries(dashboard.groups || {}).flatMap(([group, ms]) =>
    ms.map((m) => ({ ...m, dashboard_group: group }))
  );
  const metricFor = (key) =>
    allMetrics.find((m) => m.metric_key === key) || { metric_key: key, display_name: key, unit: null };

  const insights = dashboard.insights || [];
  const summary = {
    openFindings: insights.length,
    forecastRisks: insights.filter((i) => i.insight_type === 'forecast_risk').length,
    readyFixes: insights.filter((i) => i.recommendation_id).length,
    metricsTotal: allMetrics.length,
  };
  useEffect(() => { onSummary?.(summary); }, [insights.length, allMetrics.length]);

  const resolve = async (insight) => {
    if (!insight.recommendation_id) return;
    setResolvingId(insight.recommendation_id);
    try {
      await api.analyst.resolveRecommendation(clientId, insight.recommendation_id);
      load();
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
      load();
    } catch (e) {
      setError(e.message || 'Failed to dismiss');
    } finally {
      setDismissingId(null);
    }
  };

  const analyzeMetric = (metricKey) => {
    setSelectedMetricKey(metricKey);
    document.getElementById('sec-diagnostics')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleSelectRecommendation = (insightId) => {
    setSelectedWorkspaceFindingId(insightId);
    document.getElementById('sec-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const renderSectionContent = (secId) => {
    switch (secId) {
      case 'hero':
        return <AnalystPredictiveHero dashboard={dashboard} />;
      case 'fixes':
        return (
          <AnalystProactiveActionBoard
            clientId={clientId}
            insights={insights}
            metricFor={metricFor}
            onResolve={resolve}
            resolvingId={resolvingId}
            onDismiss={dismiss}
            dismissingId={dismissingId}
            onAnalyzeFurther={analyzeMetric}
            onOpenFinding={handleSelectRecommendation}
          />
        );
      case 'studio':
        return <AnalystPredictiveStudio dashboard={dashboard} />;
      case 'summary':
        return <AnalystExecutiveSummary clientId={clientId} />;
      case 'priorities':
        return (
          <AnalystRecommendationPriorityList
            clientId={clientId}
            insights={insights}
            metricFor={metricFor}
            onSelectRecommendation={handleSelectRecommendation}
          />
        );
      case 'workspace':
        return (
          <AnalystInvestigationWorkspace
            clientId={clientId}
            insights={insights}
            metricFor={metricFor}
            onResolve={resolve}
            resolvingId={resolvingId}
            onDismiss={dismiss}
            dismissingId={dismissingId}
            onAnalyzeFurther={analyzeMetric}
            externalSelectedId={selectedWorkspaceFindingId}
          />
        );
      case 'diagnostics':
        return (
          <div id="analyst-forecast-center">
            {allMetrics.length === 0 ? (
              <AnalystEmptyState
                icon={LineChart}
                title="No Diagnostic Metrics Found"
                description="Ingest search console or website analytics data to analyze diagnostic tools."
              />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4 items-start">
                <AnalystMetricNavigator
                  metrics={allMetrics}
                  insights={insights}
                  selectedMetricKey={selectedMetricKey}
                  onSelect={setSelectedMetricKey}
                />

                {selectedMetricKey && (
                  <div className="space-y-5 min-w-0">
                    <AnalystDiagnosticHero
                      metric={metricFor(selectedMetricKey)}
                      lastIngestedAt={dashboard.last_ingested_at}
                    />

                    <div className="grid grid-cols-1 lg:grid-cols-[1.85fr_1fr] gap-5 items-start">
                      <AnalystTrendCard
                        clientId={clientId}
                        metrics={allMetrics}
                        selectedMetricKey={selectedMetricKey}
                        onSelectMetric={setSelectedMetricKey}
                        insights={insights}
                      />
                      <AnalystForecastSummaryCard clientId={clientId} metric={metricFor(selectedMetricKey)} />
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                      <AnalystAiAnalystCard
                        clientId={clientId}
                        metric={metricFor(selectedMetricKey)}
                        insight={insights.find((i) => i.metric_key === selectedMetricKey)}
                      />
                      <AnalystInvestigationTimeline
                        metric={metricFor(selectedMetricKey)}
                        insights={insights}
                      />
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                      <AnalystDiagnosticsPanel clientId={clientId} metricKey={selectedMetricKey} />
                      <AnalystFeatureImportanceChart clientId={clientId} targetMetricKey={selectedMetricKey} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      case 'correlations':
        return <AnalystCorrelationExplorer clientId={clientId} />;
      case 'keyword-discovery':
        return <AnalystKeywordDiscovery clientId={clientId} />;
      default:
        return null;
    }
  };

  const densitySpacing = density === 'compact' ? 'space-y-4' : density === 'spacious' ? 'space-y-8' : 'space-y-6';

  return (
    <div className="space-y-5">
      <div className={densitySpacing}>
        {sectionList
          .filter((sec) => sec.visible)
          .map((sec, idx) => (
            <SectionShell
              key={sec.id}
              sec={sec}
              idx={idx}
              sectionList={sectionList}
              handleMoveSection={handleMoveSection}
              handleToggleSection={handleToggleSection}
            >
              {renderSectionContent(sec.id)}
            </SectionShell>
          ))}
      </div>

      <AnalystCopilotDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        clientId={clientId}
        initialPrompt={copilotInitialPrompt}
      />

      <AnalystCommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onSelectPreset={handleSelectPreset}
        onSelectTheme={handleSelectTheme}
        onSelectDensity={handleSelectDensity}
        onNavigateSection={handleNavigateSection}
        onOpenCopilot={() => {
          setCopilotInitialPrompt('');
          setDrawerOpen(true);
        }}
        activePreset={preset}
        activeTheme={theme}
        activeDensity={density}
      />

      <AnalystCustomizerDrawer
        isOpen={customizerOpen}
        onClose={() => setCustomizerOpen(false)}
        sections={sectionList}
        onToggleSection={handleToggleSection}
        onMoveSection={handleMoveSection}
        activePreset={preset}
        onSelectPreset={handleSelectPreset}
        activeTheme={theme}
        onSelectTheme={handleSelectTheme}
        activeDensity={density}
        onSelectDensity={handleSelectDensity}
        onResetLayout={handleResetLayout}
      />

      <AnalystKeyboardShortcutsModal
        isOpen={shortcutsModalOpen}
        onClose={() => setShortcutsModalOpen(false)}
      />
    </div>
  );
}

export default function Analyst() {
  const [clients, setClients] = useState(null);
  const [clientId, setClientId] = useState(null);
  const [summary, setSummary] = useState(null);

  const [activePreset, setActivePreset] = useState(() => localStorage.getItem('analyst_preset') || 'executive');
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotPrompt, setCopilotPrompt] = useState('');

  useEffect(() => {
    api.clients.list()
      .then((list) => {
        const active = (list || []).filter((c) => c.status === 'active');
        setClients(active);
        if (active.length) setClientId((prev) => prev ?? active[0].id);
      })
      .catch(() => setClients([]));
  }, []);

  const handleSelectPreset = (newPreset) => {
    setActivePreset(newPreset);
    localStorage.setItem('analyst_preset', newPreset);
  };

  const handleOpenCopilotWithPrompt = (promptText) => {
    setCopilotPrompt(promptText);
    setCopilotOpen(true);
  };

  return (
    <div className="analyst-root min-h-screen">
      {/* Page backdrop */}
<div className="fixed inset-0 pointer-events-none -z-10"
        style={{
          background:
            'radial-gradient(900px 420px at 8% -5%, rgba(108,99,255,0.10), transparent 55%),' +
            'radial-gradient(700px 380px at 95% -8%, rgba(6,182,212,0.07), transparent 55%),' +
            'radial-gradient(800px 500px at 50% 110%, rgba(236,72,153,0.05), transparent 55%),' +
            'linear-gradient(180deg,#f7f8fc 0%,#eef1f6 55%,#f7f8fc 100%)',
        }}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">
        <AnalystHeaderOS
          clients={clients || []}
          selectedClientId={clientId}
          onSelectClient={setClientId}
          activePreset={activePreset}
          onSelectPreset={handleSelectPreset}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onOpenCopilotWithPrompt={handleOpenCopilotWithPrompt}
          onToggleCustomizer={() => setCustomizerOpen(true)}
          onOpenShortcuts={() => setShortcutsModalOpen(true)}
          summary={summary}
        />

        {clients === null ? (
          <div className="py-12">
            <AnalystSkeletonLoader variant="hero" />
          </div>
        ) : clients.length === 0 ? (
          <div className="py-12">
            <AnalystEmptyState
              icon={Activity}
              title="No Active Clients Onboarded"
              description="Onboard your first site or client tenant in Platform Administration to access the AI Data Analyst Operating System."
            />
          </div>
        ) : clientId ? (
          <AnalystBody key={clientId} clientId={clientId} onSummary={setSummary} />
        ) : null}

        <AnalystCommandPalette
          isOpen={commandPaletteOpen}
          onClose={() => setCommandPaletteOpen(false)}
          onSelectPreset={handleSelectPreset}
          onSelectTheme={() => {}}
          onSelectDensity={() => {}}
          onNavigateSection={(id) => {
            const el = document.getElementById(id);
            if (el) el.scrollIntoView({ behavior: 'smooth' });
          }}
          onOpenCopilot={() => {
            setCopilotPrompt('');
            setCopilotOpen(true);
          }}
          activePreset={activePreset}
        />

        <AnalystKeyboardShortcutsModal
          isOpen={shortcutsModalOpen}
          onClose={() => setShortcutsModalOpen(false)}
        />

        <AnalystCopilotDrawer
          open={copilotOpen}
          onClose={() => setCopilotOpen(false)}
          clientId={clientId}
          initialPrompt={copilotPrompt}
        />
      </div>
    </div>
  );
}
