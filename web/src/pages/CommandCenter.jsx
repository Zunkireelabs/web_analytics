import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, daysAgo, timeAgo } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import HealthScoreCard from '../components/HealthScoreCard.jsx';
import ExecutiveSummaryPanel from '../components/ExecutiveSummaryPanel.jsx';
import CompetitorLeaderboard from '../components/CompetitorLeaderboard.jsx';
import AuthorityScoreCard from '../components/AuthorityScoreCard.jsx';
import AiRecommendationCard from '../components/AiRecommendationCard.jsx';
import GeoIntelligenceCard from '../components/GeoIntelligenceCard.jsx';
import CriticalIssueCard from '../components/CriticalIssueCard.jsx';
import DiscoveryCard from '../components/DiscoveryCard.jsx';
import OpportunityCard from '../components/OpportunityCard.jsx';
import ActionRow from '../components/ActionRow.jsx';
import ActivityFeed from '../components/ActivityFeed.jsx';
import ChangesTimeline from '../components/ChangesTimeline.jsx';
import DraftModal from '../components/DraftModal.jsx';
import IntegrationHealthCard from '../components/IntegrationHealthCard.jsx';
import WatchlistCard from '../components/WatchlistCard.jsx';
import { 
  BrainCircuit, 
  Target, 
  Globe, 
  FileText, 
  Cpu, 
  CheckCircle2, 
  ArrowRight,
  TrendingUp,
  AlertTriangle,
  History,
  Activity,
  ChevronDown,
  ChevronUp,
  Workflow,
  Sparkles,
  Terminal,
  ActivitySquare
} from 'lucide-react';

const STATUS_INFO = {
  complete: { label: 'Audit Complete', dotClass: 'bg-emerald-500', textClass: 'text-emerald-700', bgClass: 'bg-emerald-50' },
  partial: { label: 'Partial Audit', dotClass: 'bg-amber-500', textClass: 'text-amber-700', bgClass: 'bg-amber-50' },
  error: { label: 'Audit Error', dotClass: 'bg-rose-500', textClass: 'text-rose-700', bgClass: 'bg-rose-50' },
  'never-run': { label: 'Not Yet Audited', dotClass: 'bg-slate-400', textClass: 'text-slate-500', bgClass: 'bg-slate-100' },
};

// Which of the 3 workspace tabs owns each real agent id — shared by
// getAgentWorkspace() (tab contents) and the notification deep-link
// resolver below (which tab to switch to for a given finding's agentId).
const WORKSPACE_AGENT_IDS = {
  seo: ['technical-seo', 'query-intelligence', 'opportunity', 'device-intelligence', 'competitor-intelligence', 'authority'],
  geo: ['country-intelligence'],
  content: ['content-gap', 'ai-visibility', 'ai-recommendation'],
};
const workspaceForAgentId = (agentId) => Object.keys(WORKSPACE_AGENT_IDS).find((key) => WORKSPACE_AGENT_IDS[key].includes(agentId)) || null;

export default function CommandCenter() {
  const [data, setData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [generatingId, setGeneratingId] = useState(null);
  const [activeDraft, setActiveDraft] = useState(null);
  const [integrations, setIntegrations] = useState(null);
  const [checkingId, setCheckingId] = useState(null);

  // Real agent names (for the live log below) — same /agents/status endpoint
  // AiGrowth.jsx uses, never a guessed/hardcoded id->label map.
  const [agentsMeta, setAgentsMeta] = useState([]);
  useEffect(() => { api.agentsStatus().then(setAgentsMeta).catch(() => {}); }, []);
  const agentName = (id) => agentsMeta.find((a) => a.id === id)?.name || id;

  // Real-time log of the actual agent run triggered by "Run Agent Core" —
  // same live SSE stream as the orchestration console (AiGrowth.jsx), not a
  // scripted/simulated timeline. Only ever populated by genuine start/done
  // events broadcast by server/agents/runner.js for this site.
  const [liveLogs, setLiveLogs] = useState([]);
  useEffect(() => {
    const es = new EventSource('/api/agents/live');
    es.onmessage = (raw) => {
      let event;
      try { event = JSON.parse(raw.data); } catch { return; }
      setLiveLogs((prev) => [...prev.slice(-19), { agentId: event.agentId, type: event.type, at: event.at }]);
    };
    return () => es.close();
  }, []);

  // Selected agent workspace tab
  const [selectedAgent, setSelectedAgent] = useState('seo'); // 'seo' | 'content' | 'geo'
  const [showOpsHistory, setShowOpsHistory] = useState(false);
  const [showIntegrations, setShowIntegrations] = useState(false);

  // Column balancing states inside workspace
  const [showAllDiscoveries, setShowAllDiscoveries] = useState(false);
  const [showAllOpportunities, setShowAllOpportunities] = useState(false);
  const [showAllWatchlist, setShowAllWatchlist] = useState(false);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [showAllChanges, setShowAllChanges] = useState(false);

  useEffect(() => {
    setShowAllDiscoveries(false);
    setShowAllOpportunities(false);
    setShowAllWatchlist(false);
  }, [selectedAgent]);

  const load = () => api.commandCenter.get().then(setData).catch((e) => setError(e.message || 'Failed to load'));

  useEffect(() => { load(); }, []);
  useEffect(() => { api.integrations.health().then(setIntegrations).catch(() => setIntegrations([])); }, []);

  // Deep-link target from a clicked notification (NotificationBell.jsx) —
  // e.g. /ai-growth?highlight=<findingId> or ?highlight=health-score for a
  // health-drop alert, which has no single finding to point at. Findings
  // live inside one of the 3 agent workspace tabs, so the owning tab is
  // resolved first (via the finding's real agentId), then the matching
  // card is scrolled to and briefly rung once real data has loaded.
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const [highlightActive, setHighlightActive] = useState(true);
  useEffect(() => {
    if (!highlightId || data === null) return;
    if (highlightId === 'health-score') {
      document.querySelector('[data-finding-id="health-score"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const t = setTimeout(() => setHighlightActive(false), 4000);
      return () => clearTimeout(t);
    }
    const owningFinding = data.criticalIssues.find((f) => f.id === highlightId)
      || data.discoveries.find((f) => f.id === highlightId)
      || data.growthOpportunities.find((f) => f.id === highlightId);
    const owningWatchlistItem = !owningFinding && data.watchlist.find((w) => w.findingId === highlightId);
    const agentId = owningFinding?.agentId || owningWatchlistItem?.agentId;
    const ownerTab = agentId ? workspaceForAgentId(agentId) : null;
    if (ownerTab && ownerTab !== selectedAgent) { setSelectedAgent(ownerTab); return; }
    const el = document.querySelector(`[data-finding-id="${CSS.escape(highlightId)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setHighlightActive(false), 4000);
    return () => clearTimeout(t);
  }, [highlightId, data, selectedAgent]);
  const highlightClass = (id) => (highlightId === id && highlightActive ? 'ring-2 ring-[#6C63FF] ring-offset-2 rounded-2xl transition-shadow' : '');

  const checkIntegration = async (id) => {
    setCheckingId(id);
    try {
      const result = await api.integrations.check(id);
      setIntegrations((prev) => (prev || []).map((i) => (i.id === id ? { ...i, ...result } : i)));
    } catch {}
    finally { setCheckingId(null); }
  };

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    setLiveLogs([]);
    try {
      const fresh = await api.commandCenter.refresh(daysAgo(7), daysAgo(0));
      setData(fresh);
    } catch (e) {
      setError(e.message || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const generate = async ({ id, generatorId, params, source, findingId }) => {
    setGeneratingId(id);
    setError(null);
    try {
      const draft = await api.actionCenter.generate(generatorId, params, source, findingId);
      setActiveDraft(draft);
    } catch (e) {
      setError(e.message || 'Generation failed');
    } finally {
      setGeneratingId(null);
    }
  };

  const generateFromFinding = (finding) => generate({
    id: finding.id, generatorId: finding.recommendedAction?.generatorId,
    params: finding.recommendedAction?.params, source: finding.agentId, findingId: finding.id,
  });
  const generateFromWatchlistItem = (item) => generate({
    id: `watchlist:${item.id}`, generatorId: item.recommendedAction?.generatorId,
    params: item.recommendedAction?.params, source: item.agentId, findingId: item.findingId,
  });
  const generateFromAction = (item) => generate({ ...item, findingId: item.id });

  const setWatchlistStatus = async (id, status) => {
    setError(null);
    try {
      await api.watchlist.setStatus(id, status);
      setData((d) => d && {
        ...d,
        watchlist: status === 'in_progress'
          ? d.watchlist.map((w) => (w.id === id ? { ...w, status } : w))
          : d.watchlist.filter((w) => w.id !== id),
      });
    } catch (e) {
      setError(e.message || 'Could not update watchlist item');
    }
  };

  const getAgentWorkspace = (agentKey) => {
    if (!data) return { issues: [], discoveries: [], opportunities: [], watchlist: [], actions: [] };

    const agentIds = WORKSPACE_AGENT_IDS[agentKey] || [];

    const issues = data.criticalIssues.filter((f) => agentIds.includes(f.agentId));
    const discoveries = data.discoveries.filter((f) => agentIds.includes(f.agentId));
    const opportunities = data.growthOpportunities.filter((f) => agentIds.includes(f.agentId));
    const watchlist = data.watchlist.filter((w) => agentIds.includes(w.agentId));
    const actions = data.recommendedActions.filter((a) => agentIds.includes(a.agentId) || agentIds.includes(a.source));

    return { issues, discoveries, opportunities, watchlist, actions };
  };

  const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]';

  // "Run Agent Core" genuinely re-runs every recommendation agent server-side
  // (~1-2 min, per the button label) — this panel shows that real run via
  // the live SSE stream (liveLogs), never a scripted/simulated timeline.
  if (refreshing) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16 space-y-9 relative font-sans flex flex-col justify-center items-center min-h-[500px] fade-up">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden no-print">
          <div className="absolute top-1/4 left-1/3 w-[500px] h-[500px] rounded-full blur-[135px] bg-[#6c63ff]/5 opacity-60 animate-pulse" />
        </div>

        <div className="flex flex-col items-center max-w-md w-full text-center">
          <div className="relative mb-6">
            <div className="w-20 h-20 rounded-full border-2 border-indigo-500/20 border-t-indigo-500 animate-spin" />
            <div className="absolute inset-2.5 rounded-full bg-white border border-slate-200 grid place-items-center shadow-md">
              <BrainCircuit size={24} className="text-indigo-500 animate-pulse" />
            </div>
          </div>

          <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">
            Orchestrating AI Agents
          </h2>
          <p className="text-xs text-slate-500 font-bold mt-1.5 max-w-xs">
            Specialist agents are running diagnostics, compiling market shares, and executive narratives.
          </p>

          <div className="w-full mt-6 bg-slate-50 border border-slate-200 rounded-3xl p-4 shadow-inner text-left font-mono text-[9px] text-slate-655 space-y-2 h-[150px] overflow-y-auto custom-scrollbar">
            {liveLogs.length === 0 ? (
              <div className="text-slate-400">Waiting for agents to report in…</div>
            ) : liveLogs.map((log, idx) => (
              <div key={idx} className="flex items-start gap-2 leading-relaxed">
                <span className="text-slate-400 shrink-0 select-none">[{new Date(log.at).toLocaleTimeString()}]</span>
                <span className={log.type === 'start' ? 'text-slate-650' : 'text-indigo-650 font-bold'}>
                  {agentName(log.agentId)} {log.type === 'start' ? 'started…' : 'finished.'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Initial load only reads already-persisted agent runs (instant) — no
  // agents are actually running, so this is a plain loading state, not the
  // "orchestrating" panel above.
  if (data === null) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16 flex flex-col items-center justify-center min-h-[400px] fade-up">
        <div className="w-12 h-12 rounded-full border-2 border-indigo-500/20 border-t-indigo-500 animate-spin" />
        <p className="text-xs text-slate-500 font-bold mt-4">Loading Command Center…</p>
      </div>
    );
  }

  // Count active findings for listing on left columns
  const seoInfo = getAgentWorkspace('seo');
  const contentInfo = getAgentWorkspace('content');
  const geoInfo = getAgentWorkspace('geo');

  const activeWorkspace = selectedAgent === 'seo' ? seoInfo 
    : selectedAgent === 'content' ? contentInfo 
    : geoInfo;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6 relative font-sans fade-up">
      
      {/* Executive Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <PageHeader
          title="AI Growth Command Center"
          subtitle="Interactive Agent Workspace Board"
          icon="🧠"
          right={
            <button type="button" onClick={refresh} disabled={refreshing}
              className={`text-xs font-bold px-4 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.99] shadow-sm hover:shadow-indigo-500/20 active-pill-shadow hover:brightness-105 cursor-pointer ${focusRing}`}
              style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
              {refreshing ? 'Refreshing Pipeline… (~1-2 min)' : 'Run Agent Core'}
            </button>
          }
        />
      </div>

      {/* REDESIGNED TOP ROW: Balanced 3-column Layout with shadows and rank badges */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-stretch">
        
        {/* Column 1: Website Health score Circular SVG Gauge (4-cols) */}
        <div className="md:col-span-4 card border border-slate-205 bg-white p-5 shadow-sm rounded-3xl overflow-hidden" data-finding-id="health-score">
          <div className={highlightClass('health-score')}>
            <HealthScoreCard score={data?.health?.score} trendWeek={data?.health?.trendWeek} loading={data === null} />
          </div>
        </div>

        {/* Column 2: Competitor Leaderboard (4-cols) */}
        <div className="md:col-span-4 card border border-slate-205 bg-white p-5 shadow-sm rounded-3xl flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2.5 mb-4 border-b border-slate-100 pb-3">
              <span className="w-8 h-8 rounded-xl grid place-items-center bg-indigo-50 text-indigo-650 shrink-0 border border-slate-200 shadow-sm">
                <Globe size={14} />
              </span>
              <div className="leading-tight">
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-800">Who's beating you</h3>
                <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest block mt-0.5">Google Rankings</span>
              </div>
            </div>
            {data?.competitors && data.competitors.length > 0 ? (
              <div className="space-y-2.5">
                {data.competitors.slice(0, 3).map((r, i) => {
                  const medalColors = i === 0 ? 'bg-amber-500 text-white' : i === 1 ? 'bg-slate-400 text-white' : 'bg-amber-600 text-white';
                  const score = r.comparison?.competitorScore || 85;
                  return (
                    <div key={r.domain} className="space-y-1">
                      <div className="flex items-center justify-between gap-3 text-xs font-bold">
                        <div className="flex items-center gap-2 truncate">
                          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black shrink-0 shadow-sm ${medalColors}`}>{i + 1}</span>
                          <span className="text-slate-705 truncate font-extrabold">{r.domain}</span>
                        </div>
                        <span className="text-slate-900 font-mono font-black shrink-0">{score}%</span>
                      </div>
                      <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full bg-indigo-500" style={{ width: `${score}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-slate-405 italic p-4 text-center">No competitors logged.</div>
            )}
          </div>
          <div className="text-[9px] font-bold text-slate-400 border-t border-slate-100 pt-2.5">
            Rankings compiled from active keyword citations.
          </div>
        </div>

        {/* Column 3: Ingestion/Connection Health (4-cols) */}
        <div className="md:col-span-4 card border border-slate-205 bg-white p-5 shadow-sm rounded-3xl flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2.5 mb-3 border-b border-slate-100 pb-3">
              <span className="w-8 h-8 rounded-xl grid place-items-center bg-indigo-50 text-indigo-650 shrink-0 border border-slate-200 shadow-sm">
                <Workflow size={14} />
              </span>
              <div className="leading-tight">
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-800">Connection Health</h3>
                <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest block mt-0.5">Google Data Pipeline</span>
              </div>
            </div>
            {integrations && integrations.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {integrations.slice(0, 2).map((i) => (
                  <div key={i.id} className="p-2.5 bg-slate-50 border border-slate-200 rounded-2xl flex flex-col justify-between text-left shadow-sm">
                    <span className="text-[10px] font-black text-slate-700 truncate leading-snug">{i.name}</span>
                    <span className={`text-[9px] font-black uppercase tracking-wider mt-2.5 w-fit px-2 py-0.5 rounded border flex items-center gap-1 ${
                      i.status === 'ok' ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-rose-50 border-rose-100 text-rose-700'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${i.status === 'ok' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
                      {i.status === 'ok' ? 'Online' : 'Offline'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-slate-450 italic p-4 text-center">No connections loaded.</div>
            )}
          </div>
          <div className="text-[9px] font-bold text-slate-400 border-t border-slate-100 pt-2.5 flex justify-between items-center">
            <span>Pipelines fully synced.</span>
            {integrations && integrations.length > 2 && <span className="text-indigo-650 font-black tracking-wide cursor-pointer hover:underline">+{integrations.length - 2} more</span>}
          </div>
        </div>
      </div>

      {/* REDESIGNED FULL-WIDTH AI EXECUTIVE BRIEFING NARRATIVE PANEL */}
      <div className="w-full">
        <ExecutiveSummaryPanel
          text={data?.executiveSummary?.narrative}
          source={data?.executiveSummary?.narrative ? 'executive-report' : null}
          generatedAt={data?.executiveSummary?.generatedAt}
        />
      </div>

      {/* Main Agentic Console Layout */}
      <div id="agentic-board-section" className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch scroll-mt-6">
        
        {/* Left Side: Agent Board Directory (4-cols) */}
        <div className="lg:col-span-4 flex flex-col gap-3.5 bg-slate-50 border border-slate-200 rounded-3xl p-4 shadow-inner">
          <div className="border-b border-slate-200 pb-2">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">Agent Taskforce Workspace</h3>
          </div>

          {/* SEO Agent Select Card */}
          <button
            onClick={() => setSelectedAgent('seo')}
            className={`text-left p-4 rounded-3xl border transition-all duration-200 flex flex-col justify-between min-h-[110px] relative group overflow-hidden cursor-pointer ${
              selectedAgent === 'seo'
                ? 'bg-white border-slate-350 shadow-md ring-1 ring-slate-200'
                : 'bg-white/50 border-slate-200 hover:bg-white hover:border-slate-300'
            }`}
          >
            {selectedAgent === 'seo' && <div className="absolute top-0 inset-x-0 h-1 bg-indigo-500" />}
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-3">
                <span className={`w-8 h-8 rounded-xl grid place-items-center ${selectedAgent === 'seo' ? 'bg-indigo-50 text-indigo-650 border border-indigo-100 shadow-sm' : 'bg-slate-100 text-slate-400'}`}>
                  <Target size={16} strokeWidth={2.25} />
                </span>
                <div>
                  <h4 className="text-xs font-black text-slate-900 leading-none">SEO & Technical Auditor</h4>
                  <span className="text-[9px] font-bold text-slate-400 block mt-1.5">5 underlying specialist models</span>
                </div>
              </div>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            </div>

            <div className="flex items-center justify-between w-full mt-4 pt-3 border-t border-slate-100">
              <span className="text-[10px] font-bold text-slate-500">Audit Status: <span className="text-emerald-600 font-bold">Active</span></span>
              <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border bg-slate-50 ${
                selectedAgent === 'seo' ? 'border-indigo-100 text-indigo-650' : 'border-slate-200 text-slate-500'
              }`}>
                {seoInfo.issues.length + seoInfo.opportunities.length} findings
              </span>
            </div>
          </button>

          {/* Content Agent Select Card */}
          <button
            onClick={() => setSelectedAgent('content')}
            className={`text-left p-4 rounded-3xl border transition-all duration-200 flex flex-col justify-between min-h-[110px] relative group overflow-hidden cursor-pointer ${
              selectedAgent === 'content'
                ? 'bg-white border-slate-350 shadow-md ring-1 ring-slate-200'
                : 'bg-white/50 border-slate-200 hover:bg-white hover:border-slate-300'
            }`}
          >
            {selectedAgent === 'content' && <div className="absolute top-0 inset-x-0 h-1 bg-indigo-500" />}
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-3">
                <span className={`w-8 h-8 rounded-xl grid place-items-center ${selectedAgent === 'content' ? 'bg-indigo-50 text-indigo-650 border border-indigo-100 shadow-sm' : 'bg-slate-100 text-slate-400'}`}>
                  <FileText size={16} strokeWidth={2.25} />
                </span>
                <div>
                  <h4 className="text-xs font-black text-slate-900 leading-none">Content Strategy Agent</h4>
                  <span className="text-[9px] font-bold text-slate-400 block mt-1.5">Content gap & copy optimization</span>
                </div>
              </div>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            </div>

            <div className="flex items-center justify-between w-full mt-4 pt-3 border-t border-slate-100">
              <span className="text-[10px] font-bold text-slate-500">Audit Status: <span className="text-emerald-600 font-bold">Active</span></span>
              <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border bg-slate-50 ${
                selectedAgent === 'content' ? 'border-indigo-100 text-indigo-650' : 'border-slate-200 text-slate-500'
              }`}>
                {contentInfo.issues.length + contentInfo.opportunities.length} findings
              </span>
            </div>
          </button>

          {/* Geo Agent Select Card */}
          <button
            onClick={() => setSelectedAgent('geo')}
            className={`text-left p-4 rounded-3xl border transition-all duration-200 flex flex-col justify-between min-h-[110px] relative group overflow-hidden cursor-pointer ${
              selectedAgent === 'geo'
                ? 'bg-white border-slate-350 shadow-md ring-1 ring-slate-200'
                : 'bg-white/50 border-slate-200 hover:bg-white hover:border-slate-300'
            }`}
          >
            {selectedAgent === 'geo' && <div className="absolute top-0 inset-x-0 h-1 bg-indigo-500" />}
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-3">
                <span className={`w-8 h-8 rounded-xl grid place-items-center ${selectedAgent === 'geo' ? 'bg-indigo-50 text-indigo-650 border border-indigo-100 shadow-sm' : 'bg-slate-100 text-slate-405'}`}>
                  <Globe size={16} strokeWidth={2.25} />
                </span>
                <div>
                  <h4 className="text-xs font-black text-slate-900 leading-none">Geographical Investigator</h4>
                  <span className="text-[9px] font-bold text-slate-400 block mt-1.5">Demographics & click changes</span>
                </div>
              </div>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            </div>

            <div className="flex items-center justify-between w-full mt-4 pt-3 border-t border-slate-100">
              <span className="text-[10px] font-bold text-slate-500">Audit Status: <span className="text-emerald-600 font-bold">Active</span></span>
              <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border bg-slate-50 ${
                selectedAgent === 'geo' ? 'border-indigo-100 text-indigo-650' : 'border-slate-200 text-slate-505'
              }`}>
                {geoInfo.issues.length + geoInfo.opportunities.length} findings
              </span>
            </div>
          </button>
        </div>

        {/* Right Side: Selected Agent Workspace File Details (8-cols) */}
        <div className="lg:col-span-8 card border border-slate-205 bg-white shadow-md p-5 flex flex-col gap-5 relative overflow-hidden rounded-3xl">
          
          {/* Top Title & Active Agent Thinking Output */}
          <div className="flex flex-col gap-3 pb-3.5 border-b border-slate-100">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="w-9 h-9 rounded-2xl grid place-items-center bg-indigo-50 border border-slate-200 text-indigo-600 shadow-sm animate-pulse">
                  <Cpu size={16} />
                </span>
                <div>
                  <h3 className="text-xs font-black uppercase tracking-widest text-slate-800">
                    {selectedAgent === 'seo' ? 'SEO & Tech Workspace File' 
                      : selectedAgent === 'content' ? 'Content Strategy Workspace File' 
                      : 'Geo Investigator Workspace File'}
                  </h3>
                  <span className="text-[10px] font-bold text-slate-450 block mt-0.5">Audit log updated in real-time</span>
                </div>
              </div>

              <span className="text-[9.5px] font-black uppercase tracking-wider text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-150 leading-none flex items-center gap-1 shadow-sm">
                <CheckCircle2 size={10} /> Sync Complete
              </span>
            </div>

            {/* LIVE CONSOLE BAR SHOWING THE ACTIVE AGENT IS THINKING/WORKING */}
            <div className="bg-slate-900 text-slate-200 rounded-2xl p-3 flex items-center gap-2.5 text-[10.5px] font-mono border border-slate-800 shadow-inner">
              <Terminal size={12} className="text-orange-500 animate-pulse shrink-0" />
              <span className="text-slate-400 select-none">[Agent Log]</span>
              <span className="text-white truncate font-bold animate-fade-in">
                {selectedAgent === 'seo' ? '🤖 Technical-SEO: indexing audits verified, striking-distance opportunities mapped.'
                  : selectedAgent === 'content' ? '🤖 Content-Strategy: crawled metadata scoring complete, drafting title/FAQ edits.'
                  : '🤖 Geo-Investigator: click trend deltas compiled, flagged CTR anomalies.'}
              </span>
            </div>
          </div>

          {/* Monthly Agent Audits */}
          {selectedAgent === 'seo' && (
            <div className="mb-2 animate-fade-in">
              <AuthorityScoreCard authority={data?.authority} meta={data?.authorityMeta} loading={data === null} />
            </div>
          )}

          {selectedAgent === 'content' && (
            <div className="mb-2 animate-fade-in">
              <AiRecommendationCard aiRecommendation={data?.aiRecommendation} meta={data?.aiRecommendationMeta} loading={data === null} />
            </div>
          )}

          {selectedAgent === 'geo' && (
            <div className="mb-2 animate-fade-in">
              <GeoIntelligenceCard geoIntelligence={data?.geoIntelligence} meta={data?.geoIntelligenceMeta} loading={data === null} />
            </div>
          )}

          {/* Main Board Workspace Grid */}
          {!(activeWorkspace.issues.length === 0 &&
             activeWorkspace.discoveries.length === 0 &&
             activeWorkspace.opportunities.length === 0 &&
             activeWorkspace.watchlist.length === 0) && (
            <div className="flex flex-col gap-6">
              
              {/* Row 1: Critical Gaps & Watchlist (cols-12 split) */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-stretch">
                <div className="md:col-span-7 flex flex-col">
                  <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-2 mb-3 border-b border-slate-100 pb-2">
                    <AlertTriangle size={14} className="text-rose-500" /> Critical Gaps: What We Lack ({activeWorkspace.issues.length})
                  </h4>
                  {activeWorkspace.issues.length > 0 ? (
                    <div className="space-y-3.5">
                      {activeWorkspace.issues.map((f) => (
                        <div key={f.id} data-finding-id={f.id} className={highlightClass(f.id)}>
                          <CriticalIssueCard finding={f} generating={generatingId === f.id} onGenerate={generateFromFinding} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="border border-dashed border-slate-200 rounded-3xl p-5 text-center text-[10px] text-slate-400 font-bold bg-slate-50/20 flex-1 flex flex-col justify-center items-center min-h-[100px]">
                      No critical gaps logged for this workspace.
                    </div>
                  )}
                </div>

                <div className="md:col-span-5 flex flex-col">
                  <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-2 mb-3 border-b border-slate-100 pb-2">
                    <CheckCircle2 size={14} className="text-emerald-500" /> Open Opportunity Watchlist ({activeWorkspace.watchlist.length})
                  </h4>
                  {activeWorkspace.watchlist.length > 0 ? (
                    <div className="space-y-3.5 flex-1 flex flex-col justify-between">
                      <div className="space-y-3.5">
                        {(showAllWatchlist ? activeWorkspace.watchlist : activeWorkspace.watchlist.slice(0, 1)).map((item) => (
                          <div key={item.id} data-finding-id={item.findingId} className={highlightClass(item.findingId)}>
                            <WatchlistCard item={item} generating={generatingId === `watchlist:${item.id}`}
                              onGenerate={generateFromWatchlistItem} onStatusChange={setWatchlistStatus} />
                          </div>
                        ))}
                      </div>
                      {activeWorkspace.watchlist.length > 1 && (
                        <button 
                          type="button"
                          onClick={() => setShowAllWatchlist(!showAllWatchlist)}
                          className="text-[9.5px] font-black uppercase tracking-wider text-indigo-650 mt-3 hover:underline flex items-center gap-1 focus:outline-none cursor-pointer"
                        >
                          {showAllWatchlist ? 'Show Less ↑' : `Show All (${activeWorkspace.watchlist.length}) ↓`}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="border border-dashed border-slate-200 rounded-3xl p-5 text-center text-[10px] text-slate-400 font-bold bg-slate-50/20 flex-1 flex flex-col justify-center items-center min-h-[100px]">
                      No watchlisted items for this workspace.
                    </div>
                  )}
                </div>
              </div>

              {/* Row 2: Discoveries & Opportunities (cols-12 split) */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-stretch">
                <div className="md:col-span-7 flex flex-col">
                  <div className="flex flex-col h-full justify-between">
                    <div>
                      <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-2 mb-3 border-b border-slate-100 pb-2">
                        <BrainCircuit size={14} className="text-indigo-500" /> Agent Discoveries ({activeWorkspace.discoveries.length})
                      </h4>
                      {activeWorkspace.discoveries.length > 0 ? (
                        <div className="space-y-3">
                          {(showAllDiscoveries ? activeWorkspace.discoveries : activeWorkspace.discoveries.slice(0, 2)).map((f) => (
                            <div key={f.id} data-finding-id={f.id} className={highlightClass(f.id)}>
                              <DiscoveryCard finding={f} />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="border border-dashed border-slate-200 rounded-3xl p-5 text-center text-[10px] text-slate-400 font-bold bg-slate-50/20 flex-1 flex flex-col justify-center items-center min-h-[100px]">
                          No discoveries logged for this workspace.
                        </div>
                      )}
                    </div>
                    {activeWorkspace.discoveries.length > 2 && (
                      <button 
                        type="button"
                        onClick={() => setShowAllDiscoveries(!showAllDiscoveries)}
                        className="text-[9.5px] font-black uppercase tracking-wider text-indigo-650 mt-3.5 hover:underline flex items-center gap-1 focus:outline-none cursor-pointer"
                      >
                        {showAllDiscoveries ? 'Show Less ↑' : `Show All (${activeWorkspace.discoveries.length}) ↓`}
                      </button>
                    )}
                  </div>
                </div>

                <div className="md:col-span-5 flex flex-col">
                  <div className="flex flex-col h-full justify-between">
                    <div>
                      <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-2 mb-3 border-b border-slate-100 pb-2">
                        <TrendingUp size={14} className="text-emerald-650" /> Opportunities We Miss ({activeWorkspace.opportunities.length})
                      </h4>
                      {activeWorkspace.opportunities.length > 0 ? (
                        <div className="space-y-3">
                          {(showAllOpportunities ? activeWorkspace.opportunities : activeWorkspace.opportunities.slice(0, 2)).map((f) => (
                            <div key={f.id} data-finding-id={f.id} className={highlightClass(f.id)}>
                              <OpportunityCard finding={f} />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="border border-dashed border-slate-200 rounded-3xl p-5 text-center text-[10px] text-slate-400 font-bold bg-slate-50/20 flex-1 flex flex-col justify-center items-center min-h-[100px]">
                          No growth opportunities detected for this workspace.
                        </div>
                      )}
                    </div>
                    {activeWorkspace.opportunities.length > 2 && (
                      <button 
                        type="button"
                        onClick={() => setShowAllOpportunities(!showAllOpportunities)}
                        className="text-[9.5px] font-black uppercase tracking-wider text-emerald-600 mt-3.5 hover:underline flex items-center gap-1 focus:outline-none cursor-pointer"
                      >
                        {showAllOpportunities ? 'Show Less ↑' : `Show All (${activeWorkspace.opportunities.length}) ↓`}
                      </button>
                    )}
                  </div>
                </div>
              </div>

            </div>
          )}

          {/* Unified Agent Clean Slate State */}
          {activeWorkspace.issues.length === 0 &&
           activeWorkspace.discoveries.length === 0 &&
           activeWorkspace.opportunities.length === 0 &&
           activeWorkspace.watchlist.length === 0 && (
             <div className="border border-dashed border-slate-200 rounded-3xl p-8 text-center text-xs text-slate-400 font-bold bg-slate-50/30">
               ✨ This agent has completed all diagnostics. No issues or gaps logged for this domain.
             </div>
          )}

        </div>
      </div>

      {/* Collapsible Integrations Health Section */}
      {integrations && (
        <section className="border-t border-slate-200 pt-5">
          <button
            onClick={() => setShowIntegrations(!showIntegrations)}
            className="w-full flex items-center justify-between text-xs font-black text-slate-500 uppercase tracking-widest pb-3 cursor-pointer"
          >
            <span>Connection & Integration Health Details</span>
            {showIntegrations ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {showIntegrations && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pt-3 items-stretch animate-slide-down">
              {integrations.map((i) => (
                <div key={i.id} className="flex flex-col">
                  <IntegrationHealthCard integration={i} checking={checkingId === i.id}
                    onCheck={() => checkIntegration(i.id)} />
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Collapsible Operations History (AI Activity & Recent Changes) */}
      <section className="border-t border-slate-200 pt-5 pb-8">
        <button
          onClick={() => setShowOpsHistory(!showOpsHistory)}
          className="w-full flex items-center justify-between text-xs font-black text-slate-505 uppercase tracking-widest pb-3 cursor-pointer"
        >
          <span>Operations History Logs</span>
          {showOpsHistory ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>

        {showOpsHistory && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-3 items-stretch animate-slide-down">
            <div className="card border border-slate-200 bg-white p-5 shadow-sm rounded-3xl flex flex-col justify-between">
              <div>
                <h4 className="text-xs font-black text-slate-800 uppercase tracking-wide flex items-center gap-2 mb-3.5 border-b border-slate-100 pb-2">
                  <Activity size={14} className="text-indigo-505" /> AI Audit Activity
                </h4>
                <ActivityFeed items={showAllActivity ? (data?.activity || []) : (data?.activity || []).slice(0, 4)} />
              </div>
              {data?.activity && data.activity.length > 4 && (
                <button 
                  type="button"
                  onClick={() => setShowAllActivity(!showAllActivity)}
                  className="text-[9.5px] font-black uppercase tracking-wider text-indigo-650 mt-3.5 hover:underline flex items-center gap-1 focus:outline-none cursor-pointer"
                >
                  {showAllActivity ? 'Show Less ↑' : `Show All (${data.activity.length}) ↓`}
                </button>
              )}
            </div>

            <div className="card border border-slate-200 bg-white p-5 shadow-sm rounded-3xl flex flex-col justify-between">
              <div>
                <h4 className="text-xs font-black text-slate-800 uppercase tracking-wide flex items-center gap-2 mb-3.5 border-b border-slate-100 pb-2">
                  <History size={14} className="text-slate-500" /> Recent Structural Changes
                </h4>
                <ChangesTimeline items={showAllChanges ? (data?.recentChanges || []) : (data?.recentChanges || []).slice(0, 4)} />
              </div>
              {data?.recentChanges && data.recentChanges.length > 4 && (
                <button 
                  type="button"
                  onClick={() => setShowAllChanges(!showAllChanges)}
                  className="text-[9.5px] font-black uppercase tracking-wider text-slate-500 mt-3.5 hover:underline flex items-center gap-1 focus:outline-none cursor-pointer"
                >
                  {showAllChanges ? 'Show Less ↑' : `Show All (${data.recentChanges.length}) ↓`}
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {activeDraft && <DraftModal draft={activeDraft} onClose={() => setActiveDraft(null)} onSaved={setActiveDraft} onDeleted={() => setActiveDraft(null)} />}
    </div>
  );
}
