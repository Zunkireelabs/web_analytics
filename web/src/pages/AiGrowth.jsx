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
import { Play, RotateCw, CheckCircle, ChevronDown, Database, Cpu, Activity, Send } from 'lucide-react';
import PageToolbar from '../components/PageToolbar.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import Section from '../components/layout/Section.jsx';
import SegmentedTabs from '../components/SegmentedTabs.jsx';
import Button from '../components/Button.jsx';
import Badge from '../components/Badge.jsx';
import { CHART, STATUS } from '../lib/palette.js';

const FALLBACK_POLL_MS = 45000;
const REFRESH_START = daysAgo(7);
const REFRESH_END = daysAgo(0);

// The real, fixed shape of the pipeline (server/agents/orchestrator.js ->
// runner.js -> the shared agent_runs table -> its readers) — rendered as a
// persistent strip on both tabs so the page reads as "a pipeline" even at
// rest, not just while the Systems Map graph is open.
const SIGNAL_STAGES = [
  { label: 'Sources', icon: Database, caption: 'GSC, GA4, crawls' },
  { label: 'Agents', icon: Cpu, caption: null },
  { label: 'Findings store', icon: Activity, caption: 'Verified issues' },
  { label: 'Reports', icon: Send, caption: 'Summaries & drafts' },
];

// Run-status badge for the Platform Operations section (Agent Taskforce /
// Execution Timeline) — migrated as-is from admin/AiOperationsCenter.jsx.
// ok → green Healthy, insufficient-data → amber Idle, error → red Failed,
// never run (null) → grey.
const OPS_RUN_STATUS = {
  ok: { tone: 'green', label: 'Healthy' },
  'insufficient-data': { tone: 'amber', label: 'Idle' },
  error: { tone: 'red', label: 'Failed' },
  null: { tone: 'grey', label: 'Never run' },
};

const fmtDuration = (ms) => (ms != null ? `${(ms / 1000).toFixed(1)}s` : '—');

export default function AiGrowth({ isInternal }) {
  const [agents, setAgents] = useState(null);
  const [activity, setActivity] = useState(null);
  const [selected, setSelected] = useState(null);
  const [runningAgents, setRunningAgents] = useState(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);

  // Operations History collapsible (migrated from the old Command Center).
  const [showOpsHistory, setShowOpsHistory] = useState(false);
  const [showAllAgents, setShowAllAgents] = useState(false); // Agent Taskforce: first 10 rows vs all

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
  const highlightClass = (active) => (active && highlightActive ? 'ring-2 ring-primary ring-offset-2 rounded-card transition-shadow' : '');

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
      addLog('Diagnostic triggers active. Click "Run audit" to run audit.', 'info');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const running = refreshing || runningAgents.size > 0;
  const active = isThinking || runningAgents.size > 0;

  // Newest real agent run (the activity feed is newest-first) — drives "Last run".
  const lastRunAt = (activity || []).reduce((best, a) => (a.createdAt && (!best || new Date(a.createdAt) > new Date(best)) ? a.createdAt : best), null);

  const introTitle = runningAgents.size > 0 ? `${runningAgents.size} agents are auditing your site`
    : isThinking ? 'Agents are auditing your site'
    : 'Agents are on standby';

  const opsAgents = ops?.agentTaskforce || [];
  const shownOpsAgents = showAllAgents ? opsAgents : opsAgents.slice(0, 10);

  const statusBadge = (status) => {
    const s = OPS_RUN_STATUS[status] || OPS_RUN_STATUS.null;
    return <Badge tone={s.tone}>{s.label}</Badge>;
  };

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-8 pt-8 pb-16">
      <PageToolbar>
        <SegmentedTabs
          options={[{ value: 'console', label: 'Interactive' }, { value: 'diagram', label: 'Systems map' }]}
          value={viewMode} onChange={setViewMode} />
        <div className="ml-auto flex items-center gap-3">
          {lastRunAt && <span className="hidden md:inline text-[13px] text-faint">Last run {timeAgo(lastRunAt)}</span>}
          <Button variant="primary" onClick={runAll} disabled={running}>
            {running ? (
              <><RotateCw size={12} className="animate-spin" /> Running…</>
            ) : (
              <><Play size={12} fill="currentColor" /> Run audit</>
            )}
          </Button>
        </div>
      </PageToolbar>

      <PageIntro
        title={introTitle}
        subtitle={`SEO, AEO and GEO agents scan, verify and document your site's performance.${lastRunAt ? ` Last full run ${timeAgo(lastRunAt)}.` : ''}`}
      />

      {refreshError && (
        <div className="rounded-card bg-[#fdecec] text-[#b42318] text-sm px-4 py-3 mb-6">{refreshError}</div>
      )}

      {/* GrowthScores: Overall / SEO / AEO / GEO — same real-score row as the
          Command Center, so the runner console leads with current performance
          before diving into the live agent stream. */}
      <div data-finding-id="health-score">
        <div className={highlightClass(highlightId === 'health-score')}>
          <GrowthScores data={ccData} loading={ccData === null} />
        </div>
      </div>

      {/* Executive summary — same pattern as Reports.jsx. */}
      <div className="mt-10">
        <ExecutiveSummaryPanel
          text={ccData?.executiveSummary?.narrative}
          source={ccData?.executiveSummary?.narrative ? 'executive-report' : null}
          generatedAt={ccData?.executiveSummary?.generatedAt}
        />
      </div>

      {/* Pipeline strip — the fixed pipeline shape, always visible so the page
          reads as "a pipeline" on both tabs, even at rest. */}
      <Section className="mt-10" title="Agent pipeline" subtitle="How a run moves from data to your reports">
        <div className="card flex items-center px-5 py-4 overflow-x-auto">
          {SIGNAL_STAGES.map((stage, i) => {
            const caption = stage.label === 'Agents'
              ? (agents?.length ? `${agents.length} specialists` : 'Specialist agents')
              : stage.caption;
            return (
              <div key={stage.label} className="contents">
                {i > 0 && <span aria-hidden className="flex-1 min-w-6 h-px bg-border-2 mx-3.5" />}
                <div className="flex items-center gap-2.5 shrink-0">
                  <span className="w-[30px] h-[30px] rounded-control bg-muted text-text grid place-items-center">
                    <stage.icon size={15} />
                  </span>
                  <div>
                    <div className="text-sm font-medium text-fg">{stage.label}</div>
                    <div className="hidden md:block text-xs text-faint">{caption}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <div className="mt-10">
        {viewMode === 'console' ? (
          /* ================= INTERACTIVE RUNNING CONSOLE ================= */
          <div className="grid gap-6 lg:grid-cols-[1fr_1.5fr] items-start">
            <Section title="Agent status" subtitle="Live output from the current run">
              <div className="card overflow-hidden">
                <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-border">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${active ? 'bg-primary' : 'bg-faint-2'}`}
                    style={{ boxShadow: '0 0 0 3px var(--muted)' }} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-fg">{active ? 'Agents running' : 'Cluster idle'}</div>
                    <div className="text-[13px] text-faint">
                      {runningAgents.size > 0
                        ? `${runningAgents.size} agents currently auditing site streams`
                        : 'Standby for diagnostic commands'}
                    </div>
                  </div>
                </div>
                <div className="bg-[#fcfcfb] px-4 py-3 min-h-[150px] max-h-[300px] overflow-y-auto font-mono text-xs leading-5 text-text custom-scrollbar">
                  {consoleLogs.map((log, idx) => (
                    <div key={idx} className="flex items-start gap-2.5">
                      <span className="text-faint shrink-0 select-none">[{log.time}]</span>
                      <span className={log.type === 'system' || log.type === 'error' ? 'text-fg font-medium' : undefined}>{log.text}</span>
                    </div>
                  ))}
                  <div ref={terminalEndRef} />
                </div>
              </div>
            </Section>

            <Section title="Live findings" subtitle={`${revealedFindings.length} findings from the latest runs`}
              action={revealedFindings.length > 0 && !isThinking ? (
                <span className="inline-flex items-center gap-1.5 text-[13px] text-[#1a7f4b]">
                  <CheckCircle size={13} /> Processing cycle complete
                </span>
              ) : null}>
              <div className="card overflow-hidden">
                {revealedFindings.length === 0 ? (
                  <div className="px-4 py-10 text-sm text-faint text-center">
                    Awaiting analysis stream — diagnostic findings will fill these in one-by-one as agents complete auditing.
                  </div>
                ) : (
                  <div className="max-h-[460px] overflow-y-auto custom-scrollbar">
                    {revealedFindings.map((f, i) => {
                      const itemCat = CATEGORY[f.category] || CATEGORY.seo;
                      const hasDetails = f.narrative && f.narrative !== f.headline;
                      return (
                        <div
                          key={f.agentId || i}
                          data-finding-agent={f.agentId}
                          className={`grid grid-cols-1 sm:grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 px-4 py-3.5 border-b border-border last:border-0 ${highlightClass(Boolean(highlightedAgentId) && f.agentId === highlightedAgentId)}`}
                        >
                          <span className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-[6px] text-xs font-medium text-text bg-white self-start w-fit"
                            style={{ boxShadow: 'inset 0 0 0 1px var(--border-2)' }}>
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: itemCat.color }} />
                            {itemCat.label}
                          </span>
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-fg">{f.headline}</div>
                            <div className="text-xs text-faint mt-1">
                              {f.name}{f.generatedAt ? ` · ${timeAgo(f.generatedAt)}` : ''}{f.stat ? ` · ${f.stat}` : ''}
                            </div>
                          </div>
                          {hasDetails ? (
                            <button type="button" onClick={() => toggleExpand(i)} aria-expanded={expandedIndices.has(i)}
                              className="text-[13px] font-medium text-primary hover:underline whitespace-nowrap self-start text-left">
                              {expandedIndices.has(i) ? 'Hide details' : 'View details'}
                            </button>
                          ) : <span />}
                          {hasDetails && expandedIndices.has(i) && (
                            <p className="sm:col-span-3 text-[13px] text-text break-words">{f.narrative}</p>
                          )}
                        </div>
                      );
                    })}
                    {isThinking && (
                      <div className="px-4 py-3.5"><div className="h-4 w-2/3 bg-muted rounded-control animate-pulse" /></div>
                    )}
                  </div>
                )}
                {revealedFindings.length > 0 && !isThinking && (
                  <div className="tbl-foot">
                    <span>{revealedFindings.length} findings</span>
                    <a href="/reports" className="btn btn--ghost btn--sm">View executive report summary</a>
                  </div>
                )}
              </div>
            </Section>
          </div>
        ) : (
          /* ================= ARCHITECTURE SYSTEM DIAGRAM ================= */
          <div>
            <Section title="Systems map" subtitle="The parallel path each run takes. Node status updates live.">
              <div className="card overflow-hidden">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 border-b border-border text-[13px] text-text">
                  {[
                    ['Running', CHART.highlight],
                    ['Ran recently', STATUS.good.color],
                    ['Failed last run', STATUS.warning.color],
                    ['Idle / not yet run', STATUS.neutral.color],
                  ].map(([label, color]) => (
                    <span key={label} className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full" style={{ background: color }} /> {label}
                    </span>
                  ))}
                </div>
                <div className="px-4 pt-3 pb-3 text-[13px] text-faint space-y-2">
                  <p>This view illustrates the parallel execution path. The status of each agent reacts live to system runner calls.</p>
                  {agenticStats?.byMode?.length > 0 && (
                    <p>
                      Agentic mode also ran {agenticStats.byMode.reduce((s, m) => s + m.sessions, 0)} time(s) in the last 30 days
                      {(() => {
                        const agentic = agenticStats.byMode.find((m) => m.mode !== 'question');
                        return agentic ? ` (avg ${agentic.avg_rounds} rounds, ${agentic.avg_tool_calls} tool calls)` : '';
                      })()} — the diagram below reflects the fixed parallel path only.
                    </p>
                  )}
                </div>

                <div className="border-t border-border">
                  {agents !== null && agents.length === 0 ? (
                    <div className="py-12 text-center text-sm text-faint">No agents available yet.</div>
                  ) : agents === null ? (
                    // Matches OrchestrationDiagram's real responsive canvas height
                    // exactly, so there's no layout jump when the graph replaces it.
                    <div className="h-[300px] md:h-[680px] bg-muted animate-pulse" />
                  ) : (
                    <OrchestrationDiagram agents={agents} onSelectAgent={setSelected} runningAgents={runningAgents} />
                  )}
                </div>
              </div>
            </Section>
            <Section className="mt-10" title="Live activity" subtitle="Latest agent events">
              <LiveActivityRail items={activity} />
            </Section>
          </div>
        )}
      </div>

      {/* ============= COMPETITOR OVERVIEW ============= */}
      {/* Real competitor standings, driven by the same ccData already powering
          the score row above. */}
      <Section className="mt-10" title="Competitors" subtitle="How you compare online · click a competitor to see why">
        {ccData?.competitors && ccData.competitors.length > 0 ? (
          <CompetitorLeaderboard profiles={ccData.competitors} />
        ) : (
          <div className="card text-sm text-faint text-center py-10">No competitors logged yet.</div>
        )}
      </Section>

      {/* ============= DETAILED AGENT INSIGHTS ============= */}
      {/* Per-category detail cards, shown together here rather than behind
          tabs. Card insides are restyled in part 2. */}
      <Section className="mt-10" label="Authority" source="Backlinks & rankings" title="Detailed agent insights"
        subtitle="What each specialist agent found this cycle">
        <div className="grid gap-6 md:grid-cols-2">
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
      </Section>

      <Section className="mt-10" label="AI search" source="ChatGPT buyer-intent prompts" title="AI search visibility">
        <AiRecommendationCard aiRecommendation={ccData?.aiRecommendation} meta={ccData?.aiRecommendationMeta} loading={ccData === null} />
      </Section>

      <Section className="mt-10" label="Audience" source="Google Analytics" title="Geographic audience" subtitle="Where your sessions come from">
        <GeoIntelligenceCard geoIntelligence={ccData?.geoIntelligence} meta={ccData?.geoIntelligenceMeta} loading={ccData === null} />
      </Section>

      {/* ============= OPERATIONS HISTORY ============= */}
      <section className="mt-10">
        <button type="button" onClick={() => setShowOpsHistory(!showOpsHistory)} aria-expanded={showOpsHistory}
          className="card w-full flex items-center justify-between px-4 py-3.5 text-sm font-medium text-fg">
          <span>Operations history</span>
          <span className="flex items-center gap-2 text-[13px] text-faint font-normal">
            Agent activity and recent site changes
            <ChevronDown size={14} className={`transition-transform duration-200 ${showOpsHistory ? 'rotate-180' : ''}`} />
          </span>
        </button>

        {showOpsHistory && (
          <div className="grid gap-6 lg:grid-cols-2 mt-6 items-start">
            <Section title="Agent activity">
              <ActivityFeed items={ccData?.activity || []} />
            </Section>
            <Section title="Recent site changes">
              <ChangesTimeline items={ccData?.recentChanges || []} />
            </Section>
          </div>
        )}
      </section>

      {/* ============= PLATFORM OPERATIONS (admin/internal only) ============= */}
      {/* Agent Taskforce, Execution Timeline, Model Status, migrated from
          admin/AiOperationsCenter.jsx. */}
      {isInternal && ops && (
        <div className="mt-10 space-y-10">
          <Section label="Platform operations" source="Staff only · across every tenant" title="Agent taskforce"
            subtitle="Every registered agent's most recent run">
            <div className="card overflow-hidden">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th className="hidden sm:table-cell">Category</th>
                    <th>Status</th>
                    <th className="num hidden sm:table-cell">Last run</th>
                    <th className="num">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {shownOpsAgents.map((a) => (
                    <tr key={a.id}>
                      <td className="font-medium">{a.name}</td>
                      <td className="hidden sm:table-cell text-text">{CATEGORY[a.category]?.label ?? a.category}</td>
                      <td>{statusBadge(a.lastRunStatus)}</td>
                      <td className="num hidden sm:table-cell">{a.lastRunAt ? timeAgo(a.lastRunAt) : 'Never run'}</td>
                      <td className="num">{fmtDuration(a.tookMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="tbl-foot">
                <span>Showing {shownOpsAgents.length} of {opsAgents.length} agents</span>
                {opsAgents.length > 10 && (
                  <Button variant="ghost" size="sm" onClick={() => setShowAllAgents((v) => !v)}>
                    {showAllAgents ? 'Show fewer' : 'Show all agents'}
                  </Button>
                )}
              </div>
            </div>
          </Section>

          <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr] items-start">
            <Section title="Execution timeline" subtitle="Most recent agent runs across every tenant">
              {ops.executionLog.length === 0 ? (
                <div className="card text-sm text-faint text-center py-10">No agent runs recorded yet.</div>
              ) : (
                <div className="card overflow-hidden">
                  <div className="max-h-96 overflow-y-auto">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Agent</th>
                          <th className="hidden sm:table-cell">Client</th>
                          <th className="num">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ops.executionLog.map((r, i) => (
                          <tr key={i}>
                            <td className="text-text whitespace-nowrap">{new Date(r.createdAt).toLocaleTimeString()}</td>
                            <td className="font-mono text-[13px] font-medium">{r.agentId}</td>
                            <td className="hidden sm:table-cell">{r.siteName}</td>
                            <td className="num">{statusBadge(r.status)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="tbl-foot"><span>Latest {ops.executionLog.length} runs</span></div>
                </div>
              )}
            </Section>

            <Section title="Model status" subtitle="Models behind each tier">
              <div className="card overflow-hidden">
                <table className="tbl">
                  <tbody>
                    <tr><td className="text-text">Active provider</td><td className="num capitalize">{ops.modelStatus.provider}</td></tr>
                    <tr><td className="text-text">Daily-tier model</td><td className="num font-mono text-[13px]">{ops.modelStatus.dailyModel}</td></tr>
                    <tr><td className="text-text">Monthly-tier model</td><td className="num font-mono text-[13px]">{ops.modelStatus.monthlyModel}</td></tr>
                    <tr><td className="text-text">Forecast engine model</td><td className="num font-mono text-[13px]">{ops.modelStatus.forecastModel}</td></tr>
                  </tbody>
                </table>
              </div>
            </Section>
          </div>
        </div>
      )}

      <AgentDetailPanel agent={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
