import { useCallback, useEffect, useState, useRef } from 'react';
import { api, daysAgo, timeAgo } from '../api.js';
import OrchestrationDiagram from '../components/orchestration/OrchestrationDiagram.jsx';
import AgentDetailPanel from '../components/orchestration/AgentDetailPanel.jsx';
import LiveActivityRail from '../components/orchestration/LiveActivityRail.jsx';
import { 
  Play, 
  Terminal, 
  Cpu, 
  Activity, 
  CheckCircle, 
  Workflow, 
  BrainCircuit, 
  AlertTriangle,
  RotateCw,
  Eye,
  Sliders,
  ChevronRight,
  Target,
  Globe,
  FileText
} from 'lucide-react';

const FALLBACK_POLL_MS = 45000;
const REFRESH_START = daysAgo(7);
const REFRESH_END = daysAgo(0);

// Keyed by the real agent ids (server/agents/*.js meta.id) — a prior version
// of this map used made-up ids that matched nothing, so every real SSE event
// silently fell back to showing the raw id instead of a label.
const AGENT_META = {
  'technical-seo': { label: 'Technical SEO Audit', icon: Target, color: '#6C63FF' },
  'opportunity': { label: 'SEO Opportunity Finder', icon: Target, color: '#a855f7' },
  'query-intelligence': { label: 'Query Intelligence', icon: Target, color: '#6366f1' },
  'device-intelligence': { label: 'Device Intelligence', icon: Sliders, color: '#10b981' },
  'country-intelligence': { label: 'Geo Market Analyst', icon: Globe, color: '#0ea5e9' },
  'ai-visibility': { label: 'AI Visibility Auditor', icon: Globe, color: '#ec4899' },
  'content-gap': { label: 'Content Gap Analyzer', icon: FileText, color: '#14b8a6' },
  'competitor-intelligence': { label: 'Competitor Intelligence', icon: Eye, color: '#f59e0b' },
  'authority': { label: 'Authority Score Auditor', icon: Sliders, color: '#ef4444' },
  'ai-recommendation': { label: 'AI Recommendation Auditor', icon: BrainCircuit, color: '#8b5cf6' },
  'executive-report': { label: 'Executive Report', icon: FileText, color: '#0f172a' },
};

export default function AiGrowth() {
  const [agents, setAgents] = useState(null); 
  const [activity, setActivity] = useState(null);
  const [selected, setSelected] = useState(null);
  const [runningAgents, setRunningAgents] = useState(new Map()); 
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);

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

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, FALLBACK_POLL_MS);
    return () => clearInterval(poll);
  }, [refresh]);

  // Connect to SSE stream
  useEffect(() => {
    const es = new EventSource('/api/agents/live');
    es.onmessage = (raw) => {
      let event;
      try { event = JSON.parse(raw.data); } catch { return; }
      
      const agentLabel = AGENT_META[event.agentId]?.label || event.agentId;

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
      await api.commandCenter.refresh(REFRESH_START, REFRESH_END);
      addLog('Server accepted the run. Awaiting agent results…', 'system');
    } catch (e) {
      setRefreshError(e.message || 'Run failed');
      addLog(`Error executing parallel pipeline: ${e.message || 'Run failed'}`, 'error');
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
      style={{ background: 'linear-gradient(180deg, #101625 0%, #0d111d 50%, #080a12 100%)' }}>
      
      {/* Visual background ambient grids */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-0">
        <div className="absolute top-0 left-1/4 w-[700px] h-[700px] rounded-full blur-[145px]"
          style={{ background: 'radial-gradient(circle, rgba(108,99,255,0.18), transparent 60%)' }} />
        <div className="absolute bottom-0 right-1/4 w-[600px] h-[600px] rounded-full blur-[135px]"
          style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.12), transparent 60%)' }} />
      </div>

      <div className="relative max-w-[1400px] mx-auto px-4 sm:px-6 md:px-10 py-8">
        
        {/* Main top title bar */}
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 mb-8">
          <div>
            <span className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-indigo-400 px-3 py-1 rounded-full mb-3 border border-indigo-500/10 bg-indigo-500/5">
              <BrainCircuit size={11} className="animate-pulse" /> Agent Intelligence Console
            </span>
            <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight">AI Agent Audit Runner</h1>
            <p className="text-xs text-slate-400 mt-1 max-w-xl font-medium">
              Watch SEO, Geo, and Content specialist agents scan, verify, and document site performance diagnostics in real-time.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* View Mode Segment Switcher */}
            <div className="flex bg-slate-900/60 p-0.5 rounded-xl border border-slate-800">
              <button 
                onClick={() => setViewMode('console')}
                className={`flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider px-3.5 py-1.5 rounded-lg transition ${
                  viewMode === 'console' ? 'bg-white text-slate-950 font-black' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Terminal size={12} /> Interactive
              </button>
              <button 
                onClick={() => setViewMode('diagram')}
                className={`flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider px-3.5 py-1.5 rounded-lg transition ${
                  viewMode === 'diagram' ? 'bg-white text-slate-950 font-black' : 'text-slate-400 hover:text-white'
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

        {viewMode === 'console' ? (
          /* ================= INTERACTIVE RUNNING CONSOLE ================= */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
            
            {/* Left side: Pulsing Reactor and Live Log Console */}
            <div className="lg:col-span-5 flex flex-col gap-6">
              
              {/* Pulsing Core Reactor card */}
              <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 flex flex-col items-center justify-center text-center relative overflow-hidden min-h-[220px]">
                <div aria-hidden className="absolute inset-0 bg-radial-glow opacity-30" />
                
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
                  <div className="w-20 h-20 rounded-full bg-slate-800 border border-slate-700/80 grid place-items-center">
                    <BrainCircuit size={28} className="text-slate-400" />
                  </div>
                )}

                <div className="mt-4 z-10">
                  <h3 className="text-xs font-black uppercase tracking-widest text-slate-200">
                    {isThinking || runningAgents.size > 0 ? 'Agent Intelligence Active' : 'Cluster Idle'}
                  </h3>
                  <p className="text-[10px] text-slate-400 font-semibold mt-1">
                    {runningAgents.size > 0 
                      ? `${runningAgents.size} agents currently auditing site streams` 
                      : 'Standby for diagnostic commands'}
                  </p>
                </div>
              </div>

              {/* Terminal Logs Panel */}
              <div className="bg-[#0b0f19] border border-slate-850 rounded-3xl p-4 flex-1 flex flex-col min-h-[250px] shadow-2xl">
                <div className="flex items-center gap-2 border-b border-slate-850 pb-2 mb-3">
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                  <span className="text-[9px] font-black uppercase tracking-widest text-slate-450 ml-2">Console Output Stream</span>
                </div>

                <div className="flex-1 overflow-y-auto max-h-[300px] font-mono text-[10px] space-y-2.5 pr-1.5 custom-scrollbar text-slate-350">
                  {consoleLogs.map((log, idx) => (
                    <div key={idx} className="leading-relaxed flex items-start gap-2.5">
                      <span className="text-slate-500 shrink-0 select-none">[{log.time}]</span>
                      <span className={
                        log.type === 'success' ? 'text-emerald-400' 
                          : log.type === 'error' ? 'text-rose-400' 
                          : log.type === 'start' ? 'text-purple-400'
                          : log.type === 'system' ? 'text-indigo-400 font-bold'
                          : 'text-slate-350'
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
            <div className="lg:col-span-7 card p-6 bg-slate-900/40 border-slate-800 flex flex-col justify-between min-h-[450px]">
              <div>
                <div className="flex items-baseline justify-between border-b border-slate-800 pb-3 mb-5">
                  <h3 className="text-sm font-black uppercase tracking-wider text-slate-300">Live Agent Findings Feed</h3>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                    {revealedFindings.length} findings revealed
                  </span>
                </div>

                {revealedFindings.length === 0 ? (
                  <div className="py-20 text-center flex flex-col items-center justify-center">
                    <Activity size={24} className="text-slate-650 animate-pulse mb-3" />
                    <p className="text-xs font-semibold text-slate-400">Awaiting analysis stream...</p>
                    <p className="text-[10px] text-slate-450 mt-1 max-w-[280px]">
                      Diagnostic findings will appear here one-by-one as agents complete auditing.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-h-[460px] overflow-y-auto pr-1.5 custom-scrollbar">
                    {revealedFindings.map((f, i) => {
                      const itemCat = CATEGORY[f.category] || CATEGORY.seo;
                      const ItemIcon = ICONS[f.category] || Target;
                      return (
                        <div 
                          key={f.agentId || i}
                          className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-4 flex flex-col justify-between hover:border-slate-700/80 transition-all duration-300 scale-up"
                        >
                          <div>
                            <div className="flex items-center justify-between border-b border-slate-850 pb-2 mb-3">
                              <span className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider" style={{ color: itemCat.color }}>
                                <ItemIcon size={12} /> {itemCat.label}
                              </span>
                              {f.stat && (
                                <span 
                                  className="text-[9px] font-bold px-2 py-0.5 rounded-full border border-slate-750 bg-slate-800/60"
                                  style={{ color: itemCat.color, borderColor: `${itemCat.color}25` }}
                                >
                                  {f.stat}
                                </span>
                              )}
                            </div>
                            <h4 className="text-xs font-extrabold text-slate-200 leading-snug">{f.headline}</h4>
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
                                  <p className="text-[10px] font-medium text-slate-400 mt-2 leading-relaxed break-words bg-slate-950/40 p-2.5 border-l-2 rounded-r-xl border-slate-800" style={{ borderLeftColor: itemCat.color }}>
                                    {f.narrative}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="mt-4 pt-2 border-t border-slate-850 flex items-center justify-between">
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
                <div className="mt-6 pt-4 border-t border-slate-800/50 flex items-center justify-between">
                  <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-1.5">
                    <CheckCircle size={12} /> Processing cycle complete
                  </span>
                  <a 
                    href="/reports" 
                    className="text-[10px] font-black uppercase tracking-wider text-indigo-400 hover:text-indigo-300 flex items-center gap-1 hover:underline"
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
            <div className="grid lg:grid-cols-3 gap-6 items-start">
              <div className="lg:col-span-2">
                <p className="text-xs text-white/45 leading-relaxed font-medium">
                  This view illustrates the parallel execution path. The status of each agent reacts live to system runner calls.
                </p>
              </div>
              <LiveActivityRail items={activity} />
            </div>

            {agents !== null && agents.length === 0 ? (
              <div className="rounded-2xl p-12 text-center text-sm text-white/40" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
                No agents available yet.
              </div>
            ) : agents === null ? (
              <div className="rounded-3xl h-[620px] animate-pulse" style={{ background: 'rgba(255,255,255,0.04)' }} />
            ) : (
              <OrchestrationDiagram agents={agents} onSelectAgent={setSelected} runningAgents={runningAgents} />
            )}
          </div>
        )}
      </div>

      <AgentDetailPanel agent={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
