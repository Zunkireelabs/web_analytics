import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, daysAgo, timeAgo } from '../api.js';
import OrchestrationDiagram from '../components/orchestration/OrchestrationDiagram.jsx';
import AgentDetailPanel from '../components/orchestration/AgentDetailPanel.jsx';
import LiveActivityRail from '../components/orchestration/LiveActivityRail.jsx';
import GrowthScores from '../components/GrowthScores.jsx';
import ExecutiveSummaryPanel from '../components/ExecutiveSummaryPanel.jsx';
import CompetitorLeaderboard from '../components/CompetitorLeaderboard.jsx';
import AuthorityScoreCard from '../components/AuthorityScoreCard.jsx';
import ReferringDomainsCard from '../components/ReferringDomainsCard.jsx';
import CompetitorBacklinkCard from '../components/CompetitorBacklinkCard.jsx';
import CompetitorRankingCard from '../components/CompetitorRankingCard.jsx';
import AiRecommendationCard from '../components/AiRecommendationCard.jsx';
import GeoIntelligenceCard from '../components/GeoIntelligenceCard.jsx';
import ActivityFeed from '../components/ActivityFeed.jsx';
import ChangesTimeline from '../components/ChangesTimeline.jsx';
import { ORCH_CATEGORY as CATEGORY } from '../components/orchestration/palette.js';
import {
  Play,
  Terminal,
  Cpu,
  Activity,
  CheckCircle,
  CheckCircle2,
  Workflow,
  BrainCircuit,
  AlertTriangle,
  RotateCw,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Target,
  Globe,
  FileText,
  Database,
  Send,
  History,
  Bot,
  ScrollText,
  Clock
} from 'lucide-react';

const FALLBACK_POLL_MS = 45000;
const REFRESH_START = daysAgo(7);
const REFRESH_END = daysAgo(0);

// Category → icon for the Live Agent Findings Feed cards — findings are
// keyed by CATEGORY, a small fixed set, unlike the live per-agent lookup
// used for SSE log labels (agentsRef, below).
const ICONS = { seo: Target, geo: Globe, content: FileText, meta: BrainCircuit };

// The real, fixed shape of the pipeline (server/agents/orchestrator.js ->
// runner.js -> the shared agent_runs table -> its readers) — rendered as a
// persistent strip on both tabs so the page reads as "a pipeline" even at
// rest, not just while the Systems Map graph is open.
const SIGNAL_STAGES = [
  { label: 'Sources', icon: Database, color: CATEGORY.seo.color },
  { label: 'Agents', icon: Cpu, color: CATEGORY.seo.color },
  { label: 'Findings Store', icon: Activity, color: CATEGORY.content.color },
  { label: 'Reports', icon: Send, color: CATEGORY.meta.color },
];

// Run-status badge styling for the Platform Operations section (Agent
// Taskforce / Execution Timeline) — migrated as-is from admin/AiOperationsCenter.jsx.
const OPS_RUN_STATUS = {
  ok: { color: '#059669', bg: '#ecfdf5', border: '#a7f3d0', label: 'Healthy', icon: CheckCircle2 },
  'insufficient-data': { color: '#d97706', bg: '#fffbeb', border: '#fde68a', label: 'Idle', icon: Clock },
  error: { color: '#dc2626', bg: '#fef2f2', border: '#fecaca', label: 'Failed', icon: AlertTriangle },
  null: { color: '#94a3b8', bg: '#f8fafc', border: '#e2e8f0', label: 'Never run', icon: Clock },
};

export default function AiGrowth({ isInternal }) {
  const [agents, setAgents] = useState(null);
  const [activity, setActivity] = useState(null);
  const [selected, setSelected] = useState(null);
  const [runningAgents, setRunningAgents] = useState(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);

  // Operations History collapsible (migrated from the old Command Center).
  const [showOpsHistory, setShowOpsHistory] = useState(false);

  // Admin/internal-only platform operations data — Agent Taskforce,
  // Execution Timeline, Model Status (migrated from admin/AiOperationsCenter.jsx).
  // Fetched only for isInternal sessions, same gate that page used to have.
  const [ops, setOps] = useState(null);
  useEffect(() => {
    if (!isInternal) return;
    api.opsCenter.get().then(setOps).catch(() => setOps(null));
  }, [isInternal]);

  // View state: 'console' (live intelligence runner, default) or 'diagram' (system graph)
  const [viewMode, setViewMode] = useState('console');
  const [isThinking, setIsThinking] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState([]);
  const [revealedFindings, setRevealedFindings] = useState([]); // Array of finding cards completed in this run
  const [expandedIndices, setExpandedIndices] = useState(new Set());
  const terminalEndRef = useRef(null);

  const toggleExpand = (idx) => {
    setExpandedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const addLog = (text, type = 'info') => {
    setConsoleLogs((prev) => [...prev, { text, type, time: new Date().toLocaleTimeString() }]);
  };

  const refresh = useCallback(() => {
    api.agentsStatus().then(setAgents).catch(() => setAgents((a) => a ?? []));
    api.agentsActivity(12).then(setActivity).catch(() => setActivity((a) => a ?? []));
  }, []);

  // The SSE handler below is set up once (mount-only effect) and must always
  // read the LATEST agent list, not whatever `agents` was when the effect
  // first ran — a ref sidesteps the stale-closure trap without forcing an
  // SSE reconnect every time `agents` refreshes.
  const agentsRef = useRef([]);
  useEffect(() => { agentsRef.current = agents; }, [agents]);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, FALLBACK_POLL_MS);
    return () => clearInterval(poll);
  }, [refresh]);

  // Real, already-persisted telemetry for the agentic tool-calling loop
  // (only populated once AGENTIC_ORCHESTRATION_ENABLED is on and a refresh
  // has actually used it) — null while loading/unavailable, never shown as
  // if it were the only execution mode.
  const [agenticStats, setAgenticStats] = useState(null);
  useEffect(() => {
    api.commandCenter.agenticStats().then(setAgenticStats).catch(() => {});
  }, []);

  // Command Center aggregate (health/authority/aiVisibility) driving the
  // GrowthScores row at the top of the console — same api.commandCenter.get()
  // the Command Center page uses, so the Overall/SEO/AEO tiles reflect real,
  // already-persisted agent runs (GEO is fetched independently inside
  // GrowthScores itself, same as on that page).
  const [ccData, setCcData] = useState(null);
  useEffect(() => {
    api.commandCenter.get().then(setCcData).catch(() => setCcData(null));
  }, []);

  // Free Common Crawl "Referring Domains" card — its own independent fetch
  // (migrated as-is from the old Command Center), not folded into ccData /
  // api.commandCenter.get(), so it stays exactly what server/routes/
  // commoncrawl-backlinks.js already exposes.
  const [ccBacklinks, setCcBacklinks] = useState(null); // null = loading
  const [ccDomainUnresolved, setCcDomainUnresolved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.sites().then(([site]) => {
      if (cancelled) return;
      const domain = site?.website_domain
        ? site.website_domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
        : null;
      if (!domain) { setCcDomainUnresolved(true); return; }
      return api.commonCrawlBacklinks.summary(domain).then((summary) => {
        if (!cancelled) setCcBacklinks(summary);
      });
    }).catch(() => {
      if (!cancelled) setCcBacklinks({ status: 'insufficient-data', message: 'Could not load referring domain data right now.' });
    });
    return () => { cancelled = true; };
  }, []);

  // Deep-link target from a clicked notification (NotificationBell.jsx) —
  // /ai-orchestration?highlight=<findingId> or ?highlight=health-score for a
  // health-drop alert (no single finding to point at). Findings themselves
  // no longer render as cards on this page (that grid was Command Center's
  // duplicate of this page's own Live Agent Findings Feed), so a specific
  // findingId is resolved to its owning agent, then rung on that agent's
  // card in the Live Agent Findings Feed if one has been revealed.
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const [highlightActive, setHighlightActive] = useState(true);

  // Resolve a findingId (from a notification) to the real agent that owns
  // it, so the matching card in the Live Agent Findings Feed can be rung —
  // there's no per-finding card on this page anymore to ring directly.
  const highlightedAgentId = useMemo(() => {
    if (!highlightId || highlightId === 'health-score' || !ccData) return null;
    const owningFinding = ccData.criticalIssues?.find((f) => f.id === highlightId)
      || ccData.discoveries?.find((f) => f.id === highlightId)
      || ccData.growthOpportunities?.find((f) => f.id === highlightId);
    const owningWatchlistItem = !owningFinding && ccData.watchlist?.find((w) => w.findingId === highlightId);
    return owningFinding?.agentId || owningWatchlistItem?.agentId || null;
  }, [highlightId, ccData]);

  useEffect(() => {
    if (!highlightId) return;
    const selector = highlightId === 'health-score'
      ? '[data-finding-id="health-score"]'
      : highlightedAgentId && `[data-finding-agent="${CSS.escape(highlightedAgentId)}"]`;
    if (!selector) return;
    const el = document.querySelector(selector);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setHighlightActive(false), 4000);
    return () => clearTimeout(t);
  }, [highlightId, highlightedAgentId, revealedFindings]);
  const highlightClass = (active) => (active && highlightActive ? 'ring-2 ring-[#6C63FF] ring-offset-2 rounded-2xl transition-shadow' : '');

  // Load findings already persisted from prior runs on mount — without this,
  // the feed only ever shows findings from a run triggered in this exact
  // browser tab/session, so a page load always reads "0 findings" even when
  // agent_runs already has real, complete data.
  useEffect(() => {
    api.reportInsights(1).then((res) => {
      if (res?.agentFindings?.length) setRevealedFindings(res.agentFindings);
    }).catch(() => {});
  }, []);

  // Connect to SSE stream
  useEffect(() => {
    const es = new EventSource(`${import.meta.env.BASE_URL}api/agents/live`);
    es.onmessage = (raw) => {
      let event;
      try { event = JSON.parse(raw.data); } catch { return; }
      
      const agentLabel = agentsRef.current.find((a) => a.id === event.agentId)?.name || event.agentId;

      if (event.type === 'start') {
        setRunningAgents((m) => new Map(m).set(event.agentId, new Date(event.at).getTime()));
        setIsThinking(true);
        addLog(`[Agent Process] Initializing ${agentLabel}...`, 'start');
      } else if (event.type === 'done') {
        setRunningAgents((m) => {
          if (!m.has(event.agentId)) return m;
          const next = new Map(m);
          next.delete(event.agentId);
          return next;
        });

        // Add a log entry and reveal finding card
        addLog(`[Agent Process] ${agentLabel} completed auditing successfully. Insights recorded.`, 'success');
        
        // Find if this agent has a recent report/finding to display
        api.reportInsights(1).then((res) => {
          const finding = res?.agentFindings?.find(f => f.agentId === event.agentId);
          if (finding) {
            setRevealedFindings((prev) => {
              // Avoid duplicates
              if (prev.some(p => p.agentId === finding.agentId)) return prev;
              return [...prev, finding];
            });
          }
        }).catch(() => {});

        refresh();
      }
    };
    return () => es.close();
  }, [refresh]);

  // Auto-scroll terminal log to bottom
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [consoleLogs]);

  // Triggers the real backend run — every log line from here on comes from
  // the real SSE agent stream (see the `es.onmessage` handler above), never
  // scripted/simulated text.
  const runAll = async () => {
    setRefreshing(true);
    setRefreshError(null);
    setIsThinking(true);
    setConsoleLogs([]);
    setRevealedFindings([]);
    setExpandedIndices(new Set());

    addLog('Requesting a fresh agent run from the server…', 'system');

    try {
      // api.commandCenter.refresh already blocks until the real backend run
      // (orchestrator/agentic loop) has fully finished and persisted — by
      // the time this await resolves, the SSE `done` events for every
      // agent that ran have already arrived (see the es.onmessage handler
      // above). So this log line describes what already happened, not what's
      // still pending — "awaiting results" here was leftover phrasing from
      // before the backend became fully synchronous, and was actively
      // misleading (reads as still-in-progress right as the run completes).
      await api.commandCenter.refresh(REFRESH_START, REFRESH_END);
      addLog('Run complete. Fetching latest results…', 'system');
      const fresh = await api.commandCenter.get();
      setCcData(fresh);
      if (isInternal) api.opsCenter.get().then(setOps).catch(() => {});
      addLog('Done — results updated.', 'system');
    } catch (e) {
      setRefreshError(e.message || 'Run failed');
      addLog(`Error executing parallel pipeline: ${e.message || 'Run failed'}`, 'error');
    } finally {
      // Previously only reset on the catch path — a successful run left
      // `refreshing`/`isThinking` stuck true forever (the "RUNNING…" button
      // label and "Agent Intelligence Active" status never cleared even
      // though the backend had already finished), since nothing on the
      // success path above ever set them back to false.
      setIsThinking(false);
      setRefreshing(false);
    }
  };

  // Real idle-state message (no agents are running yet) — timestamps use the
  // actual current time via addLog, never a fabricated fixed clock time.
  useEffect(() => {
    if (consoleLogs.length === 0) {
      addLog('Analytics Agent Core initialized. All systems standby.', 'system');
      addLog('Diagnostic triggers active. Click "▶ Run Agent Pipeline" to run audit.', 'info');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative min-h-screen w-full overflow-hidden"
      style={{ background: 'linear-gradient(160deg, #eafaf6 0%, #eef6ff 50%, #f5f0ff 100%)' }}>

      {/* Visual background ambient grids — teal -> violet, echoing the
          signal-path hue sweep (ingest/teal through synthesis/violet). */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-0">
        <div className="absolute top-0 left-1/4 w-[700px] h-[700px] rounded-full blur-[145px]"
          style={{ background: 'radial-gradient(circle, rgba(13,148,136,0.10), transparent 60%)' }} />
        <div className="absolute bottom-0 right-1/4 w-[600px] h-[600px] rounded-full blur-[135px]"
          style={{ background: 'radial-gradient(circle, rgba(124,58,237,0.10), transparent 60%)' }} />
      </div>

      <div className="relative max-w-[1400px] mx-auto px-4 sm:px-6 md:px-10 py-8">

        {/* Main top title bar */}
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 mb-8">
          <div>
            <span className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-indigo-600 px-3 py-1 rounded-full mb-3 border border-indigo-500/15 bg-indigo-500/5">
              <BrainCircuit size={11} className="animate-pulse" /> Agent Intelligence Console
            </span>
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">AI Agent Audit Runner</h1>
            <p className="text-xs text-slate-500 mt-1 max-w-xl font-medium">
              Watch SEO, Geo, and Content specialist agents scan, verify, and document site performance diagnostics in real-time.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* View Mode Segment Switcher */}
            <div className="flex bg-white/70 p-0.5 rounded-xl border border-slate-200">
              <button
                onClick={() => setViewMode('console')}
                className={`flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider px-3.5 py-1.5 rounded-lg transition ${
                  viewMode === 'console' ? 'bg-slate-900 text-white font-black shadow-sm' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <Terminal size={12} /> Interactive
              </button>
              <button
                onClick={() => setViewMode('diagram')}
                className={`flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider px-3.5 py-1.5 rounded-lg transition ${
                  viewMode === 'diagram' ? 'bg-slate-900 text-white font-black shadow-sm' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <Workflow size={12} /> Systems Map
              </button>
            </div>

            <button 
              type="button" 
              onClick={runAll} 
              disabled={refreshing || runningAgents.size > 0}
              className="text-[10px] font-black uppercase tracking-wider px-4 py-2 rounded-xl text-white transition disabled:opacity-50 flex items-center gap-1.5 active-pill-shadow hover:brightness-105"
              style={{ background: 'linear-gradient(135deg, #6C63FF, #8b5cf6)' }}
            >
              {refreshing || runningAgents.size > 0 ? (
                <>
                  <RotateCw size={11} className="animate-spin" /> Running...
                </>
              ) : (
                <>
                  <Play size={11} fill="currentColor" /> Run Audit
                </>
              )}
            </button>
          </div>
        </div>

        {/* Executive summary — leads the page, same pattern as Reports.jsx
            (mounted directly under the page header, first content block). */}
        <div className="mb-6">
          <ExecutiveSummaryPanel
            text={ccData?.executiveSummary?.narrative}
            source={ccData?.executiveSummary?.narrative ? 'executive-report' : null}
            generatedAt={ccData?.executiveSummary?.generatedAt}
          />
        </div>

        {/* GrowthScores: Overall / SEO / AEO / GEO — same real-score row as
            the Command Center, so the runner console leads with current
            performance before diving into the live agent stream. */}
        <div className="mb-6" data-finding-id="health-score">
          <div className={highlightClass(highlightId === 'health-score')}>
            <GrowthScores data={ccData} loading={ccData === null} />
          </div>
        </div>

        {/* Signal Path strip — the fixed pipeline shape, always visible so
            the page reads as "a pipeline" on both tabs, even at rest. */}
        <div className="card rounded-2xl mb-6 px-5 py-4 flex items-center gap-1 overflow-x-auto custom-scrollbar">
          {SIGNAL_STAGES.map((stage, i) => (
            <div key={stage.label} className="flex items-center gap-1 shrink-0">
              {i > 0 && (
                <span aria-hidden className="w-6 sm:w-10 h-px mx-1 shrink-0"
                  style={{ backgroundImage: 'repeating-linear-gradient(90deg, rgba(108,99,255,0.4) 0 6px, transparent 6px 12px)' }} />
              )}
              <div className="flex flex-col items-center gap-1.5 w-20 sm:w-24 shrink-0">
                <span className="w-8 h-8 rounded-lg grid place-items-center"
                  style={{ background: `${stage.color}1a`, color: stage.color }}>
                  <stage.icon size={14} />
                </span>
                <span className="text-[9px] font-black uppercase tracking-wider text-slate-500 text-center leading-tight">
                  {stage.label}
                </span>
              </div>
            </div>
          ))}
        </div>

        {viewMode === 'console' ? (
          /* ================= INTERACTIVE RUNNING CONSOLE ================= */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
            
            {/* Left side: Pulsing Reactor and Live Log Console */}
            <div className="lg:col-span-5 flex flex-col gap-6">
              
              {/* Pulsing Core Reactor card */}
              <div className="card rounded-3xl p-6 flex flex-col items-center justify-center text-center relative overflow-hidden min-h-[220px]">
                <div aria-hidden className="absolute inset-0 opacity-40 pointer-events-none"
                  style={{ background: 'radial-gradient(circle at 50% 20%, rgba(108,99,255,0.12), transparent 65%)' }} />

                {isThinking || runningAgents.size > 0 ? (
                  <div className="relative">
                    {/* Glowing outer rotating ring */}
                    <div className="w-20 h-20 rounded-full border-2 border-indigo-500/20 border-t-indigo-500 animate-spin" />
                    {/* Glowing inner core */}
                    <div className="absolute inset-2 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 animate-pulse blur-[1px] grid place-items-center">
                      <Cpu size={24} className="text-white" />
                    </div>
                  </div>
                ) : (
                  <div className="relative w-20 h-20 rounded-full bg-slate-50 border border-slate-200 grid place-items-center">
                    <svg viewBox="0 0 80 80" fill="none" className="absolute inset-0">
                      <circle cx="40" cy="40" r="38" stroke={CATEGORY.seo.color} strokeOpacity="0.18" strokeWidth="1.5" strokeDasharray="2 5" />
                    </svg>
                    <BrainCircuit size={28} className="text-slate-400" />
                  </div>
                )}

                <div className="mt-4 z-10">
                  <h3 className="text-xs font-black uppercase tracking-widest text-slate-800">
                    {isThinking || runningAgents.size > 0 ? 'Agent Intelligence Active' : 'Cluster Idle'}
                  </h3>
                  <p className="text-[10px] text-slate-500 font-semibold mt-1">
                    {runningAgents.size > 0
                      ? `${runningAgents.size} agents currently auditing site streams`
                      : 'Standby for diagnostic commands'}
                  </p>
                  {!(isThinking || runningAgents.size > 0) && (
                    <div className="flex items-center justify-center gap-1.5 mt-2.5">
                      {Object.values(CATEGORY).map((cat) => (
                        <span key={cat.label} className="w-1.5 h-1.5 rounded-full" style={{ background: cat.color }} />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Terminal Logs Panel */}
              <div className="card rounded-3xl p-4 flex-1 flex flex-col min-h-[250px]">
                <div className="flex items-center gap-2 border-b border-slate-200 pb-2 mb-3">
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-400" />
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                  <span className="text-[9px] font-black uppercase tracking-widest text-slate-500 ml-2">Console Output Stream</span>
                </div>

                <div className="flex-1 overflow-y-auto max-h-[300px] font-mono text-[10px] space-y-2.5 pr-1.5 custom-scrollbar text-slate-600">
                  {consoleLogs.map((log, idx) => (
                    <div key={idx} className="leading-relaxed flex items-start gap-2.5">
                      <span className="text-slate-500 shrink-0 select-none">[{log.time}]</span>
                      <span className={
                        log.type === 'success' ? 'text-emerald-600'
                          : log.type === 'error' ? 'text-rose-600'
                          : log.type === 'start' ? 'text-purple-600'
                          : log.type === 'system' ? 'text-indigo-600 font-bold'
                          : 'text-slate-600'
                      }>
                        {log.text}
                      </span>
                    </div>
                  ))}
                  <div ref={terminalEndRef} />
                </div>
              </div>
            </div>

            {/* Right side: Revealed Diagnostic analysis cards list */}
            <div className="lg:col-span-7 card p-6 flex flex-col justify-between min-h-[450px]">
              <div>
                <div className="flex items-baseline justify-between border-b border-slate-200 pb-3 mb-5">
                  <h3 className="text-sm font-black uppercase tracking-wider text-slate-800">Live Agent Findings Feed</h3>
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                    {revealedFindings.length} findings revealed
                  </span>
                </div>

                {revealedFindings.length === 0 ? (
                  <div>
                    <p className="text-[10px] text-slate-400 mb-4">
                      Awaiting analysis stream — diagnostic findings will fill these in one-by-one as agents complete auditing.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {Object.entries(CATEGORY).map(([key, cat]) => {
                        const ItemIcon = ICONS[key] || Target;
                        return (
                          <div key={key} className="rounded-2xl p-4 flex flex-col gap-3 min-h-[110px]"
                            style={{ border: `1.5px dashed ${cat.color}40`, background: `${cat.color}0a` }}>
                            <span className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider opacity-80" style={{ color: cat.color }}>
                              <ItemIcon size={12} /> {cat.label}
                            </span>
                            <div className="space-y-1.5">
                              <span className="block h-1.5 rounded-full w-4/5" style={{ background: `${cat.color}30` }} />
                              <span className="block h-1.5 rounded-full w-3/5" style={{ background: `${cat.color}30` }} />
                            </div>
                            <span className="text-[9px] text-slate-400 mt-auto">Waiting on {cat.label} agents…</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-h-[460px] overflow-y-auto pr-1.5 custom-scrollbar">
                    {revealedFindings.map((f, i) => {
                      const itemCat = CATEGORY[f.category] || CATEGORY.seo;
                      const ItemIcon = ICONS[f.category] || Target;
                      return (
                        <div
                          key={f.agentId || i}
                          data-finding-agent={f.agentId}
                          className={`bg-white border border-slate-200 rounded-2xl p-4 flex flex-col justify-between hover:border-slate-300 hover:shadow-md transition-all duration-300 ${highlightClass(Boolean(highlightedAgentId) && f.agentId === highlightedAgentId)}`}
                        >
                          <div>
                            <div className="flex items-center justify-between border-b border-slate-100 pb-2 mb-3">
                              <span className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider" style={{ color: itemCat.color }}>
                                <ItemIcon size={12} /> {itemCat.label}
                              </span>
                              {f.stat && (
                                <span
                                  className="text-[9px] font-bold px-2 py-0.5 rounded-full border bg-slate-50"
                                  style={{ color: itemCat.color, borderColor: `${itemCat.color}25` }}
                                >
                                  {f.stat}
                                </span>
                              )}
                            </div>
                            <h4 className="text-xs font-extrabold text-slate-800 leading-snug">{f.headline}</h4>
                            {f.narrative && f.narrative !== f.headline && (
                              <div className="mt-2.5">
                                <button
                                  type="button"
                                  onClick={() => toggleExpand(i)}
                                  className="text-[9px] font-black uppercase tracking-wider hover:underline transition-colors"
                                  style={{ color: itemCat.color }}
                                >
                                  {expandedIndices.has(i) ? 'Hide Details ↑' : 'View Details →'}
                                </button>
                                {expandedIndices.has(i) && (
                                  <p className="text-[10px] font-medium text-slate-600 mt-2 leading-relaxed break-words bg-slate-50 p-2.5 border-l-2 rounded-r-xl border-slate-200" style={{ borderLeftColor: itemCat.color }}>
                                    {f.narrative}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="mt-4 pt-2 border-t border-slate-100 flex items-center justify-between">
                            <span className="text-[9px] font-bold text-slate-500">Agent: {f.name}</span>
                            {f.generatedAt && (
                              <span className="text-slate-500 text-[10px] flex items-center gap-0.5 font-bold">
                                <CheckCircle size={10} /> {timeAgo(f.generatedAt)}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {revealedFindings.length > 0 && !isThinking && (
                <div className="mt-6 pt-4 border-t border-slate-200 flex items-center justify-between">
                  <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-1.5">
                    <CheckCircle size={12} /> Processing cycle complete
                  </span>
                  <a
                    href="/reports"
                    className="text-[10px] font-black uppercase tracking-wider text-indigo-600 hover:text-indigo-500 flex items-center gap-1 hover:underline"
                  >
                    View executive report summary <ChevronRight size={12} />
                  </a>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ================= ARCHITECTURE SYSTEM DIAGRAM ================= */
          <div className="space-y-6">
            <div className="grid lg:grid-cols-3 gap-6 items-stretch">
              <div className="lg:col-span-2 card rounded-2xl p-5 flex flex-col justify-center">
                <p className="text-xs text-slate-600 leading-relaxed font-medium mb-4">
                  This view illustrates the parallel execution path. The status of each agent reacts live to system runner calls.
                </p>
                {agenticStats?.byMode?.length > 0 && (
                  <p className="text-[11px] text-indigo-600 font-semibold mb-4 -mt-2">
                    Agentic mode also ran {agenticStats.byMode.reduce((s, m) => s + m.sessions, 0)} time(s) in the last 30 days
                    {(() => {
                      const agentic = agenticStats.byMode.find((m) => m.mode !== 'question');
                      return agentic ? ` (avg ${agentic.avg_rounds} rounds, ${agentic.avg_tool_calls} tool calls)` : '';
                    })()} — the diagram above reflects the fixed parallel path only.
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-4 border-t border-slate-200">
                  <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 mr-1">Node status</span>
                  <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-600">
                    <span className="w-2 h-2 rounded-full" style={{ background: '#a78bfa' }} /> Running
                  </span>
                  <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-600">
                    <span className="w-2 h-2 rounded-full" style={{ background: '#059669' }} /> Ran recently
                  </span>
                  <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-600">
                    <span className="w-2 h-2 rounded-full" style={{ background: '#f59e0b' }} /> Failed last run
                  </span>
                  <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-600">
                    <span className="w-2 h-2 rounded-full" style={{ background: '#64748b' }} /> Idle / not yet run
                  </span>
                </div>
              </div>
              <LiveActivityRail items={activity} />
            </div>

            {agents !== null && agents.length === 0 ? (
              <div className="rounded-2xl p-12 text-center text-sm text-slate-400" style={{ border: '1px solid rgba(15,23,42,0.08)' }}>
                No agents available yet.
              </div>
            ) : agents === null ? (
              // Matches OrchestrationDiagram's real responsive canvas height
              // exactly, so there's no layout jump when the graph replaces it.
              <div className="rounded-3xl h-[300px] md:h-[680px] animate-pulse" style={{ background: 'rgba(15,23,42,0.04)' }} />
            ) : (
              <OrchestrationDiagram agents={agents} onSelectAgent={setSelected} runningAgents={runningAgents} />
            )}
          </div>
        )}

        {/* ============= COMPETITOR OVERVIEW ============= */}
        {/* Migrated from the old Command Center page — real competitor
            standings, driven by the same ccData already powering the score
            row above. (Executive summary now leads the page, above.) */}
        <div className="relative card border border-slate-200 bg-gradient-to-br from-white to-orange-50/10 p-5 shadow-sm rounded-3xl flex flex-col justify-between overflow-hidden mt-8">
          <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-orange-400 to-rose-400" />
          <div>
            <div className="flex items-center gap-2.5 mb-4 border-b border-slate-100 pb-3">
              <span className="w-8 h-8 rounded-xl grid place-items-center bg-orange-50 text-orange-600 shrink-0 border border-orange-100 shadow-sm">
                <Globe size={14} />
              </span>
              <div className="leading-tight">
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-800">Competitor Overview</h3>
                <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest block mt-0.5">How you compare online</span>
              </div>
            </div>
            {ccData?.competitors && ccData.competitors.length > 0 ? (
              <CompetitorLeaderboard profiles={ccData.competitors} />
            ) : (
              <div className="text-xs text-slate-455 italic p-4 text-center">No competitors logged.</div>
            )}
          </div>
          <div className="text-[9px] font-bold text-slate-400 border-t border-slate-100 pt-2.5">
            Click a competitor to see why.
          </div>
        </div>

        {/* ============= DETAILED AGENT INSIGHTS ============= */}
        {/* Migrated per-category detail cards from the old Command Center's
            3-tab agent workspace — shown together here rather than behind
            tabs, since the tab-switching findings-by-category UI itself
            duplicated this page's own Live Agent Findings Feed above. */}
        <div className="mt-8 space-y-6">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-indigo-600" />
            <h2 className="text-xs font-black text-slate-900 uppercase tracking-widest">Detailed Agent Insights</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <AuthorityScoreCard authority={ccData?.authority} meta={ccData?.authorityMeta} loading={ccData === null} />
            <ReferringDomainsCard
              summary={ccDomainUnresolved ? null : ccBacklinks}
              loading={!ccDomainUnresolved && ccBacklinks === null}
            />
            <CompetitorBacklinkCard
              backlinkComparison={ccData?.backlinkComparison}
              meta={ccData?.backlinkComparisonMeta}
              loading={ccData === null}
            />
            <CompetitorRankingCard
              rankingComparison={ccData?.rankingComparison}
              meta={ccData?.rankingComparisonMeta}
              loading={ccData === null}
            />
          </div>

          <AiRecommendationCard aiRecommendation={ccData?.aiRecommendation} meta={ccData?.aiRecommendationMeta} loading={ccData === null} />

          <GeoIntelligenceCard geoIntelligence={ccData?.geoIntelligence} meta={ccData?.geoIntelligenceMeta} loading={ccData === null} />
        </div>

        {/* ============= OPERATIONS HISTORY ============= */}
        <section className="border-t border-slate-200 pt-5 mt-8">
          <button
            onClick={() => setShowOpsHistory(!showOpsHistory)}
            className="w-full flex items-center justify-between text-xs font-black text-slate-500 uppercase tracking-widest pb-3 cursor-pointer hover:text-slate-800 transition-colors focus:outline-none"
          >
            <span className="flex items-center gap-2">
              <History size={14} className="text-indigo-500" />
              <span>Operations History Logs</span>
            </span>
            {showOpsHistory ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {showOpsHistory && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 p-6 items-start animate-slide-down bg-gradient-to-tr from-indigo-50/20 via-transparent to-violet-50/15 border border-indigo-100/50 rounded-[32px] mt-2 shadow-inner">
              <div className="relative card border border-indigo-100 bg-gradient-to-br from-white/90 via-white/80 to-slate-50/50 backdrop-blur-md p-6 shadow-md rounded-[28px] flex flex-col justify-start overflow-hidden hover:shadow-lg transition-all duration-300">
                <div className="absolute -right-8 -top-8 w-20 h-20 rounded-full blur-2xl opacity-20 bg-indigo-400 pointer-events-none" />
                <div>
                  <div className="flex items-center gap-2.5 mb-6 border-b border-slate-100 pb-4">
                    <span className="w-8 h-8 rounded-xl grid place-items-center bg-indigo-50 text-indigo-650 shrink-0 border border-indigo-100/80 shadow-sm">
                      <Activity size={14} />
                    </span>
                    <div className="leading-tight">
                      <h3 className="text-xs font-black uppercase tracking-widest text-slate-800">AI Audit Activity</h3>
                      <span className="text-[8px] font-bold text-slate-405 uppercase tracking-widest block mt-0.5">What our AI checked</span>
                    </div>
                  </div>
                  <div className="max-h-[380px] overflow-y-auto pr-1.5 custom-scrollbar">
                    <ActivityFeed items={ccData?.activity || []} />
                  </div>
                </div>
              </div>

              <div className="relative card border border-slate-200 bg-gradient-to-br from-white/90 via-white/80 to-slate-50/50 backdrop-blur-md p-6 shadow-md rounded-[28px] flex flex-col justify-start overflow-hidden hover:shadow-lg transition-all duration-300">
                <div className="absolute -right-8 -top-8 w-20 h-20 rounded-full blur-2xl opacity-20 bg-slate-400 pointer-events-none" />
                <div>
                  <div className="flex items-center gap-2.5 mb-6 border-b border-slate-100 pb-4">
                    <span className="w-8 h-8 rounded-xl grid place-items-center bg-slate-55 text-slate-650 shrink-0 border border-slate-200/85 shadow-sm">
                      <History size={14} />
                    </span>
                    <div className="leading-tight">
                      <h3 className="text-xs font-black uppercase tracking-widest text-slate-800">Recent Website Changes</h3>
                      <span className="text-[8px] font-bold text-slate-405 uppercase tracking-widest block mt-0.5">What changed on your site</span>
                    </div>
                  </div>
                  <div className="max-h-[380px] overflow-y-auto pr-1.5 custom-scrollbar">
                    <ChangesTimeline items={ccData?.recentChanges || []} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* ============= PLATFORM OPERATIONS (admin/internal only) ============= */}
        {/* Migrated from admin/AiOperationsCenter.jsx — Agent Taskforce,
            Execution Timeline, Model Status. Everything else on that page
            (status strip, hero health score, metric cards, executive
            summary bullets, critical findings, pipeline health, scheduler,
            audit/system-health links, roadmap list) was either a duplicate
            of what Orchestration already shows or explicitly dropped. */}
        {isInternal && ops && (
          <div className="mt-8 space-y-6">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-fuchsia-600" />
              <h2 className="text-xs font-black text-slate-900 uppercase tracking-widest">Platform Operations</h2>
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Staff only — across every tenant</span>
            </div>

            <div className="bg-white rounded-3xl border border-slate-150 shadow-sm p-6">
              <div className="flex items-center gap-3 mb-5 border-b border-slate-100 pb-4">
                <span className="w-9 h-9 rounded-2xl bg-indigo-50 grid place-items-center text-indigo-500 shrink-0"><Bot size={15} /></span>
                <div>
                  <h3 className="text-sm font-black text-slate-800">Agent Taskforce</h3>
                  <p className="text-[11px] font-semibold text-slate-400 mt-0.5">Every registered agent's most recent run, across all tenants</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {ops.agentTaskforce.map((a) => {
                  const s = OPS_RUN_STATUS[a.lastRunStatus] || OPS_RUN_STATUS.null;
                  const Icon = s.icon;
                  return (
                    <div key={a.id} className="rounded-2xl border border-slate-150 bg-gradient-to-br from-slate-50/80 to-white p-4 flex flex-col gap-2 hover:shadow-md hover:-translate-y-0.5 transition-all duration-300">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-black text-slate-800 truncate">{a.name}</span>
                        <span className="text-[8px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border shrink-0 flex items-center gap-1" style={{ color: s.color, backgroundColor: s.bg, borderColor: s.border }}>
                          <Icon size={9} />{s.label}
                        </span>
                      </div>
                      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{a.category}</span>
                      <div className="flex items-center justify-between text-[10px] font-semibold text-slate-500 mt-1 pt-2 border-t border-slate-100">
                        <span>{a.lastRunAt ? timeAgo(a.lastRunAt) : 'Never run'}</span>
                        <span className="font-mono font-black text-slate-600">{a.tookMs != null ? `${a.tookMs}ms` : '—'}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="bg-white rounded-3xl border border-slate-150 shadow-sm p-6">
              <div className="flex items-center gap-3 mb-5 border-b border-slate-100 pb-4">
                <span className="w-9 h-9 rounded-2xl bg-indigo-50 grid place-items-center text-indigo-500 shrink-0"><ScrollText size={15} /></span>
                <div>
                  <h3 className="text-sm font-black text-slate-800">Execution Timeline</h3>
                  <p className="text-[11px] font-semibold text-slate-400 mt-0.5">Most recent agent runs across every tenant</p>
                </div>
              </div>
              {ops.executionLog.length === 0 ? (
                <p className="text-xs text-slate-400 italic py-2">No agent runs recorded yet.</p>
              ) : (
                <div className="relative max-h-96 overflow-y-auto pl-1">
                  <div className="absolute left-[7px] top-2 bottom-2 w-px bg-slate-150" />
                  <div className="space-y-4">
                    {ops.executionLog.map((r, i) => {
                      const s = OPS_RUN_STATUS[r.status] || OPS_RUN_STATUS.null;
                      return (
                        <div key={i} className="relative pl-6">
                          <span className="absolute left-0 top-1 w-3.5 h-3.5 rounded-full border-2 border-white shadow" style={{ background: s.color }} />
                          <div className="flex items-center justify-between gap-3 text-xs">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-[9px] font-mono text-slate-400 shrink-0">{new Date(r.createdAt).toLocaleTimeString()}</span>
                              <span className="font-black text-slate-800 truncate">{r.agentId}</span>
                              <span className="text-slate-400 font-medium truncate">· {r.siteName}</span>
                            </div>
                            <span className="text-[9px] font-black uppercase tracking-wider" style={{ color: s.color }}>{s.label}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-white rounded-3xl border border-slate-150 shadow-sm p-6">
              <div className="flex items-center gap-3 mb-5 border-b border-slate-100 pb-4">
                <span className="w-9 h-9 rounded-2xl bg-indigo-50 grid place-items-center text-indigo-500 shrink-0"><Cpu size={15} /></span>
                <h3 className="text-sm font-black text-slate-800">Model Status</h3>
              </div>
              <div className="space-y-3 text-[12px] font-semibold text-slate-600">
                <div className="flex justify-between items-center"><span className="text-slate-400">Active provider</span><span className="font-black text-slate-800 capitalize bg-slate-50 px-2.5 py-1 rounded-lg">{ops.modelStatus.provider}</span></div>
                <div className="flex justify-between items-center"><span className="text-slate-400">Daily-tier model</span><span className="font-mono text-[11px]">{ops.modelStatus.dailyModel}</span></div>
                <div className="flex justify-between items-center"><span className="text-slate-400">Monthly-tier model</span><span className="font-mono text-[11px]">{ops.modelStatus.monthlyModel}</span></div>
                <div className="flex justify-between items-center"><span className="text-slate-400">Forecast engine model</span><span className="font-mono text-[11px]">{ops.modelStatus.forecastModel}</span></div>
              </div>
            </div>
          </div>
        )}
      </div>

      <AgentDetailPanel agent={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
