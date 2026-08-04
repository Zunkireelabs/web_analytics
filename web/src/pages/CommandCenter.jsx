import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, daysAgo, timeAgo } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import GrowthScores from '../components/GrowthScores.jsx';
import GeoScorecard from '../components/GeoScorecard.jsx';
import ExecutiveSummaryPanel from '../components/ExecutiveSummaryPanel.jsx';
import CompetitorLeaderboard from '../components/CompetitorLeaderboard.jsx';
import AuthorityScoreCard from '../components/AuthorityScoreCard.jsx';
import ReferringDomainsCard from '../components/ReferringDomainsCard.jsx';
import CompetitorBacklinkCard from '../components/CompetitorBacklinkCard.jsx';
import CompetitorRankingCard from '../components/CompetitorRankingCard.jsx';
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
  ActivitySquare
} from 'lucide-react';

// Plain-English steps shown while a check is running (no agent/internal
// names) — see ACTIVITY_STEPS usage in the refreshing panel below.
const ACTIVITY_STEPS = ['Website scanned', 'SEO analyzed', 'Content reviewed', 'Recommendations prepared', 'Monitoring continues'];

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
const WORKSPACE_LABELS = { seo: 'SEO', content: 'Content', geo: 'Geo' };

export default function CommandCenter() {
  const [data, setData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [generatingId, setGeneratingId] = useState(null);
  const [activeDraft, setActiveDraft] = useState(null);
  const [integrations, setIntegrations] = useState(null);
  const [checkingId, setCheckingId] = useState(null);

  // Real-time log of the actual agent run triggered by "Fix Everything Automatically" —
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


  useEffect(() => {
    setShowAllDiscoveries(false);
    setShowAllOpportunities(false);
    setShowAllWatchlist(false);
  }, [selectedAgent]);

  const load = () => api.commandCenter.get().then(setData).catch((e) => setError(e.message || 'Failed to load'));

  useEffect(() => { load(); }, []);
  useEffect(() => { api.integrations.health().then(setIntegrations).catch(() => setIntegrations([])); }, []);

  // Free Common Crawl "Referring Domains" card — deliberately its own
  // independent fetch (own state, own effect), not folded into `data`/
  // api.commandCenter.get(), so this stays exactly what server/routes/
  // commoncrawl-backlinks.js already exposes with zero changes to
  // server/agents/lib/command-center.js's aggregation.
  const [ccBacklinks, setCcBacklinks] = useState(null); // null = loading
  const [ccDomainUnresolved, setCcDomainUnresolved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.sites().then(([site]) => {
      if (cancelled) return;
      // Same normalization as server/agents/lib/site-domain.js's
      // knownDomain() (server-only, not importable here) — must match what
      // the ETL stored in commoncrawl_backlink_summary.domain.
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

  // Plain business-facing summary for a left-rail card: healthy/needs
  // attention, how many issues, and the worst priority among them — the
  // "Website SEO / ✓ Healthy / Issues Found / Priority" card shape.
  const tabSummary = (info) => {
    const items = [...info.issues, ...info.opportunities, ...info.discoveries];
    const priority = items.some((f) => f.priority === 'high') ? 'High'
      : items.some((f) => f.priority === 'medium') ? 'Medium'
      : items.length ? 'Low' : null;
    return { issuesFound: info.issues.length, priority, healthy: info.issues.length === 0 };
  };

  const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]';

  // "Fix Everything Automatically" genuinely re-runs every recommendation agent server-side
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
            Checking Your Website
          </h2>
          <p className="text-xs text-slate-500 font-bold mt-1.5 max-w-xs">
            We're scanning your pages, checking your rankings, and preparing your report.
          </p>

          <div className="w-full mt-6 bg-slate-50 border border-slate-200 rounded-3xl p-5 shadow-inner text-left space-y-3">
            {ACTIVITY_STEPS.map((step, idx) => {
              const done = liveLogs.filter((l) => l.type === 'done').length > idx;
              return (
                <div key={step} className="flex items-center gap-2.5">
                  <span className={`w-5 h-5 rounded-full grid place-items-center shrink-0 text-[10px] font-black ${
                    done ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-400'
                  }`}>
                    {done ? '✓' : idx + 1}
                  </span>
                  <span className={`text-xs font-bold ${done ? 'text-slate-700' : 'text-slate-400'}`}>{step}</span>
                </div>
              );
            })}
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
  const seoSummary = tabSummary(seoInfo);
  const contentSummary = tabSummary(contentInfo);
  const geoSummary = tabSummary(geoInfo);

  // Real analysis status (never-run/complete/partial/error, computed server-
  // side from the actual latest executive-report run) — shared across all 3
  // taskforce cards since they all run together via the same orchestration
  // pass; there's no real per-category run status to show independently.
  const analysisStatusInfo = STATUS_INFO[data?.stats?.analysisStatus] || STATUS_INFO['never-run'];
  const lastAnalyzedLabel = data?.stats?.lastAnalyzedAt ? timeAgo(data.stats.lastAnalyzedAt) : 'never';
  // Most recent real activity row for whichever agent group is selected —
  // replaces a fixed narrative string the terminal bar used to always show
  // regardless of whether that agent had ever actually run.
  const workspaceActivity = (data?.activity || []).find((a) => WORKSPACE_AGENT_IDS[selectedAgent]?.includes(a.agentId));

  const activeWorkspace = selectedAgent === 'seo' ? seoInfo
    : selectedAgent === 'content' ? contentInfo
    : geoInfo;

  // Watchlist items are filtered per-tab (by owning agent), so a tab can
  // legitimately show 0 while another tab has real open items — surfaced
  // here so the empty state points there instead of reading as "nothing to
  // do at all."
  const otherWatchlistTabs = Object.entries({ seo: seoInfo, content: contentInfo, geo: geoInfo })
    .filter(([key, info]) => key !== selectedAgent && info.watchlist.length > 0)
    .map(([key, info]) => ({ key, label: WORKSPACE_LABELS[key], count: info.watchlist.length }));

  const agentTheme = {
    seo: {
      color: '#6C63FF',
      textClass: 'text-indigo-650',
      bgClass: 'bg-indigo-50/50',
      borderClass: 'border-indigo-150',
      gradientBar: 'bg-gradient-to-r from-[#6C63FF] to-[#8b5cf6]',
      terminalText: 'text-indigo-400',
      headingClass: 'text-indigo-600 border-indigo-100',
      badgeClass: 'text-indigo-650 bg-indigo-50 border-indigo-150',
      glowBg: 'bg-indigo-50/20',
      glowBorder: 'border-indigo-200/60',
      glowSoftBorder: 'border-indigo-100',
      glowAccent1: 'bg-indigo-400',
      glowAccent2: 'bg-indigo-300',
    },
    content: {
      color: '#14b8a6',
      textClass: 'text-teal-650',
      bgClass: 'bg-teal-50/50',
      borderClass: 'border-teal-150',
      gradientBar: 'bg-gradient-to-r from-teal-500 to-emerald-500',
      terminalText: 'text-teal-400',
      headingClass: 'text-teal-600 border-teal-100',
      badgeClass: 'text-teal-600 bg-teal-50 border-teal-150',
      glowBg: 'bg-teal-50/20',
      glowBorder: 'border-teal-200/60',
      glowSoftBorder: 'border-teal-100',
      glowAccent1: 'bg-teal-400',
      glowAccent2: 'bg-teal-300',
    },
    geo: {
      color: '#0ea5e9',
      textClass: 'text-sky-600',
      bgClass: 'bg-sky-50/50',
      borderClass: 'border-sky-150',
      gradientBar: 'bg-gradient-to-r from-sky-500 to-blue-500',
      terminalText: 'text-sky-400',
      headingClass: 'text-sky-600 border-sky-100',
      badgeClass: 'text-sky-600 bg-sky-50 border-sky-150',
      glowBg: 'bg-sky-50/20',
      glowBorder: 'border-sky-200/60',
      glowSoftBorder: 'border-sky-100',
      glowAccent1: 'bg-sky-400',
      glowAccent2: 'bg-sky-300',
    }
  }[selectedAgent];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6 relative font-sans fade-up">
      
      {/* Executive Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <PageHeader
          title="AI Growth Command Center"
          subtitle="Your Website's Health, Issues & Next Steps"
          icon="🧠"
          right={
            <button type="button" onClick={refresh} disabled={refreshing}
              className={`text-xs font-bold px-4 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.99] shadow-sm hover:shadow-indigo-500/20 active-pill-shadow hover:brightness-105 cursor-pointer ${focusRing}`}
              style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
              {refreshing ? 'Checking your website… (~1-2 min)' : 'Fix Everything Automatically'}
            </button>
          }
        />
      </div>

      {/* SCORE ROW: Overall / SEO / AEO / GEO — four real, independently
          computed 0–100 signals shown at the top. Overall comes from Website
          Health, SEO from Authority Score, AEO from AI-visibility readiness,
          and GEO from the latest geo-audit draft (fetched in-component). */}
      <div className="grid grid-cols-1 gap-4" data-finding-id="health-score">
        <div className={highlightClass('health-score')}>
          <GrowthScores data={data} loading={data === null} />
        </div>
      </div>

      {/* SECOND ROW: Competitor Overview + Data Connection */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">

        {/* Column 1: Competitor Leaderboard (6-cols) */}
        <div className="lg:col-span-6 relative card border border-slate-200 bg-gradient-to-br from-white to-orange-50/10 p-5 shadow-sm rounded-3xl flex flex-col justify-between overflow-hidden">
          {/* Top Indicator bar */}
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
            {data?.competitors && data.competitors.length > 0 ? (
              <CompetitorLeaderboard profiles={data.competitors} />
            ) : (
              <div className="text-xs text-slate-455 italic p-4 text-center">No competitors logged.</div>
            )}
          </div>
          <div className="text-[9px] font-bold text-slate-400 border-t border-slate-100 pt-2.5">
            Click a competitor to see why.
          </div>
        </div>

        {/* Column 2: Ingestion/Connection Health (6-cols) */}
        <div className="lg:col-span-6 relative card border border-slate-200 bg-gradient-to-br from-white to-emerald-50/10 p-5 shadow-sm rounded-3xl flex flex-col justify-between overflow-hidden">
          {/* Top Indicator bar */}
          <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-emerald-400 to-teal-400" />
          <div>
            <div className="flex items-center gap-2.5 mb-3 border-b border-slate-100 pb-3">
              <span className="w-8 h-8 rounded-xl grid place-items-center bg-emerald-50 text-emerald-600 shrink-0 border border-emerald-100 shadow-sm">
                <Workflow size={14} />
              </span>
              <div className="leading-tight">
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-800">Data Connection</h3>
                <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest block mt-0.5">Google Analytics & Search Console</span>
              </div>
            </div>
            {integrations && integrations.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {integrations.slice(0, 2).map((i) => (
                  <div key={i.id} className={`p-2.5 bg-slate-50 border rounded-2xl flex flex-col justify-between text-left shadow-sm ${i.status === 'ok' ? 'border-emerald-100/50' : 'border-rose-100/50'}`}>
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
            <span>Everything's connected.</span>
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
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">Website Improvements</h3>
          </div>

          {/* SEO Agent Select Card */}
          <button
            onClick={() => setSelectedAgent('seo')}
            className={`text-left p-4 rounded-3xl border transition-all duration-300 flex flex-col justify-between min-h-[110px] relative group overflow-hidden cursor-pointer ${
              selectedAgent === 'seo'
                ? 'bg-gradient-to-br from-white to-indigo-50/20 border-indigo-300 shadow-md ring-1 ring-indigo-100'
                : 'bg-white/50 border-slate-200 hover:bg-white hover:border-slate-300'
            }`}
          >
            {selectedAgent === 'seo' && <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-[#6C63FF] to-[#8b5cf6]" />}
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-3">
                <span className={`w-8 h-8 rounded-xl grid place-items-center ${selectedAgent === 'seo' ? 'bg-indigo-50 text-indigo-650 border border-indigo-150 shadow-sm' : 'bg-slate-100 text-slate-400'}`}>
                  <Target size={16} strokeWidth={2.25} />
                </span>
                <div>
                  <h4 className="text-xs font-black text-slate-900 leading-none">Website SEO Check</h4>
                  <span className={`text-[9px] font-black uppercase tracking-wider block mt-1.5 ${seoSummary.healthy ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {seoSummary.healthy ? '✓ Healthy' : '⚠ Needs Attention'}
                  </span>
                </div>
              </div>
            </div>

            <div className="w-full mt-4 pt-3 border-t border-slate-100 space-y-1.5">
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
                <span>Issues Found</span><span className="font-black text-slate-800">{seoSummary.issuesFound}</span>
              </div>
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
                <span>Priority</span><span className="font-black text-slate-800">{seoSummary.priority || 'None'}</span>
              </div>
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
                <span>Last Checked</span><span className="font-black text-slate-800">{lastAnalyzedLabel}</span>
              </div>
              <div className={`text-[9.5px] font-black uppercase tracking-wider pt-1 ${selectedAgent === 'seo' ? 'text-indigo-650' : 'text-slate-400'}`}>
                View Report →
              </div>
            </div>
          </button>

          {/* Content Agent Select Card */}
          <button
            onClick={() => setSelectedAgent('content')}
            className={`text-left p-4 rounded-3xl border transition-all duration-300 flex flex-col justify-between min-h-[110px] relative group overflow-hidden cursor-pointer ${
              selectedAgent === 'content'
                ? 'bg-gradient-to-br from-white to-teal-50/20 border-teal-300 shadow-md ring-1 ring-teal-100'
                : 'bg-white/50 border-slate-200 hover:bg-white hover:border-slate-300'
            }`}
          >
            {selectedAgent === 'content' && <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-teal-500 to-emerald-500" />}
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-3">
                <span className={`w-8 h-8 rounded-xl grid place-items-center ${selectedAgent === 'content' ? 'bg-teal-55 text-teal-650 border border-teal-150 shadow-sm' : 'bg-slate-100 text-slate-400'}`}>
                  <FileText size={16} strokeWidth={2.25} />
                </span>
                <div>
                  <h4 className="text-xs font-black text-slate-900 leading-none">Content Recommendations</h4>
                  <span className={`text-[9px] font-black uppercase tracking-wider block mt-1.5 ${contentSummary.healthy ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {contentSummary.healthy ? '✓ Healthy' : '⚠ Needs Attention'}
                  </span>
                </div>
              </div>
            </div>

            <div className="w-full mt-4 pt-3 border-t border-slate-100 space-y-1.5">
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
                <span>Issues Found</span><span className="font-black text-slate-800">{contentSummary.issuesFound}</span>
              </div>
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
                <span>Priority</span><span className="font-black text-slate-800">{contentSummary.priority || 'None'}</span>
              </div>
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
                <span>Last Checked</span><span className="font-black text-slate-800">{lastAnalyzedLabel}</span>
              </div>
              <div className={`text-[9.5px] font-black uppercase tracking-wider pt-1 ${selectedAgent === 'content' ? 'text-teal-650' : 'text-slate-400'}`}>
                View Report →
              </div>
            </div>
          </button>

          {/* Geo Agent Select Card */}
          <button
            onClick={() => setSelectedAgent('geo')}
            className={`text-left p-4 rounded-3xl border transition-all duration-300 flex flex-col justify-between min-h-[110px] relative group overflow-hidden cursor-pointer ${
              selectedAgent === 'geo'
                ? 'bg-gradient-to-br from-white to-sky-50/20 border-sky-350 shadow-md ring-1 ring-sky-100'
                : 'bg-white/50 border-slate-200 hover:bg-white hover:border-slate-300'
            }`}
          >
            {selectedAgent === 'geo' && <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-sky-500 to-blue-500" />}
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-3">
                <span className={`w-8 h-8 rounded-xl grid place-items-center ${selectedAgent === 'geo' ? 'bg-sky-50 text-sky-600 border border-sky-150 shadow-sm' : 'bg-slate-100 text-slate-405'}`}>
                  <Globe size={16} strokeWidth={2.25} />
                </span>
                <div>
                  <h4 className="text-xs font-black text-slate-900 leading-none">Audience Insights</h4>
                  <span className={`text-[9px] font-black uppercase tracking-wider block mt-1.5 ${geoSummary.healthy ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {geoSummary.healthy ? '✓ Healthy' : '⚠ Needs Attention'}
                  </span>
                </div>
              </div>
            </div>

            <div className="w-full mt-4 pt-3 border-t border-slate-100 space-y-1.5">
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
                <span>Issues Found</span><span className="font-black text-slate-800">{geoSummary.issuesFound}</span>
              </div>
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
                <span>Priority</span><span className="font-black text-slate-800">{geoSummary.priority || 'None'}</span>
              </div>
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
                <span>Last Checked</span><span className="font-black text-slate-800">{lastAnalyzedLabel}</span>
              </div>
              <div className={`text-[9.5px] font-black uppercase tracking-wider pt-1 ${selectedAgent === 'geo' ? 'text-sky-600' : 'text-slate-400'}`}>
                View Report →
              </div>
            </div>
          </button>
        </div>

        {/* Right Side: Selected Agent Workspace File Details (8-cols) */}
        <div className="lg:col-span-8 card border border-slate-205 bg-white shadow-md p-5 flex flex-col gap-5 relative overflow-hidden rounded-3xl">
          {/* Active Agent Top Accent Gradient Line */}
          <div className={`absolute top-0 inset-x-0 h-1.5 ${agentTheme.gradientBar}`} />
          
          {/* Workspace File Header */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <span className={`w-10 h-10 rounded-2xl grid place-items-center border shadow-md ${agentTheme.bgClass} ${agentTheme.borderClass} ${agentTheme.textClass} shrink-0`}>
                  <Cpu size={18} />
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-black uppercase tracking-widest text-slate-900">
                      {selectedAgent === 'seo' ? 'Website Health Details'
                        : selectedAgent === 'content' ? 'Content Health Details'
                        : 'Audience Health Details'}
                    </h3>
                  </div>
                  <span className="text-[10px] font-bold text-slate-400 block mt-0.5">Last analyzed {lastAnalyzedLabel}</span>
                </div>
              </div>

              <span className={`text-[10px] font-black uppercase tracking-wider px-3 py-1 rounded-full border leading-none flex items-center gap-1.5 shadow-2xs ${analysisStatusInfo.bgClass} ${analysisStatusInfo.textClass}`}
                style={{ borderColor: 'currentColor' }}>
                <span className={`w-1.5 h-1.5 rounded-full ${analysisStatusInfo.dotClass} animate-pulse`} /> {analysisStatusInfo.label}
              </span>
            </div>

            {/* Latest AI Activity */}
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3.5 flex items-center gap-3 text-[11px] shadow-sm">
              <ActivitySquare size={14} className={`${agentTheme.textClass} shrink-0`} />
              <div className="min-w-0">
                <span className="text-slate-400 font-bold select-none">Latest AI Activity: </span>
                <span className="text-slate-700 truncate font-semibold">
                  {workspaceActivity
                    ? `✓ ${workspaceActivity.label} (${timeAgo(workspaceActivity.createdAt)})`
                    : 'No activity recorded yet for this section.'}
                </span>
              </div>
            </div>
          </div>



          {/* Monthly Agent Audits - 2x2 Grid Layout */}
          {selectedAgent === 'seo' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4 animate-fade-in">
              <AuthorityScoreCard authority={data?.authority} meta={data?.authorityMeta} loading={data === null} />
              <ReferringDomainsCard
                summary={ccDomainUnresolved ? null : ccBacklinks}
                loading={!ccDomainUnresolved && ccBacklinks === null}
              />
              <CompetitorBacklinkCard
                backlinkComparison={data?.backlinkComparison}
                meta={data?.backlinkComparisonMeta}
                loading={data === null}
              />
              <CompetitorRankingCard
                rankingComparison={data?.rankingComparison}
                meta={data?.rankingComparisonMeta}
                loading={data === null}
              />
            </div>
          )}

          {selectedAgent === 'content' && (
            <div className="mb-4 animate-fade-in">
              <AiRecommendationCard aiRecommendation={data?.aiRecommendation} meta={data?.aiRecommendationMeta} loading={data === null} />
            </div>
          )}

          {selectedAgent === 'geo' && (
            <div className="mb-4 animate-fade-in flex flex-col gap-4">
              <GeoIntelligenceCard geoIntelligence={data?.geoIntelligence} meta={data?.geoIntelligenceMeta} loading={data === null} />
              <GeoScorecard onOpenReport={setActiveDraft} />
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
                  <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
                    <span className="flex items-center gap-2">
                      <AlertTriangle size={14} className="text-rose-500" /> Needs Your Attention
                    </span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${activeWorkspace.issues.length > 0 ? 'bg-rose-100 text-rose-700 font-extrabold' : 'bg-slate-100 text-slate-500'}`}>
                      {activeWorkspace.issues.length}
                    </span>
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
                    <div className="border border-slate-200/60 rounded-2xl p-6 text-center bg-slate-50/40 flex-1 flex flex-col justify-center items-center min-h-[120px] space-y-1.5">
                      <div className="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-600 grid place-items-center border border-emerald-100 shadow-2xs">
                        <CheckCircle2 size={16} />
                      </div>
                      <p className="text-xs font-black text-slate-800">No Critical Gaps</p>
                      <p className="text-[11px] text-slate-400 font-medium max-w-xs">All technical, structural & accessibility checks are clear for this workspace.</p>
                    </div>
                  )}
                </div>

                <div className="md:col-span-5 flex flex-col">
                  <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
                    <span className="flex items-center gap-2">
                      <CheckCircle2 size={14} className={agentTheme.textClass} /> Quick Wins
                    </span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${activeWorkspace.watchlist.length > 0 ? 'bg-indigo-100 text-indigo-700 font-extrabold' : 'bg-slate-100 text-slate-500'}`}>
                      {activeWorkspace.watchlist.length}
                    </span>
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
                          className={`text-[9.5px] font-black uppercase tracking-wider mt-3 hover:underline flex items-center gap-1 focus:outline-none cursor-pointer ${agentTheme.textClass}`}
                        >
                          {showAllWatchlist ? 'Show Less ↑' : `Show All (${activeWorkspace.watchlist.length}) ↓`}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="border border-slate-200/60 rounded-2xl p-6 text-center bg-slate-50/40 flex-1 flex flex-col justify-center items-center min-h-[120px] space-y-2">
                      <span className="text-xs font-bold text-slate-600">No Watchlisted Items</span>
                      {otherWatchlistTabs.length > 0 && (
                        <span className="flex flex-wrap justify-center gap-2">
                          {otherWatchlistTabs.map((tab) => (
                            <button
                              key={tab.key}
                              type="button"
                              onClick={() => setSelectedAgent(tab.key)}
                              className="text-[10px] font-extrabold uppercase tracking-wider text-indigo-600 bg-indigo-50 border border-indigo-100 px-2.5 py-1 rounded-lg hover:bg-indigo-100 transition cursor-pointer"
                            >
                              +{tab.count} in {tab.label} →
                            </button>
                          ))}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Row 2: Discoveries & Opportunities (cols-12 split) */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-stretch">
                <div className="md:col-span-7 flex flex-col">
                  <div className="flex flex-col h-full justify-between">
                    <div>
                      <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
                        <span className="flex items-center gap-2">
                          <BrainCircuit size={14} className={agentTheme.textClass} /> Growth Opportunities
                        </span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${activeWorkspace.discoveries.length > 0 ? 'bg-indigo-100 text-indigo-700 font-extrabold' : 'bg-slate-100 text-slate-500'}`}>
                          {activeWorkspace.discoveries.length}
                        </span>
                      </h4>
                      {activeWorkspace.discoveries.length > 0 ? (
                        <div className="space-y-3">
                          {(showAllDiscoveries ? activeWorkspace.discoveries : activeWorkspace.discoveries.slice(0, 2)).map((f) => (
                            <div key={f.id} data-finding-id={f.id} className={highlightClass(f.id)}>
                              <DiscoveryCard finding={f} generating={generatingId === f.id} onGenerate={generateFromFinding} />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="border border-slate-200/60 rounded-2xl p-6 text-center bg-slate-50/40 flex-1 flex flex-col justify-center items-center min-h-[120px] space-y-1">
                          <p className="text-xs font-bold text-slate-600">No Discoveries Flagged</p>
                          <p className="text-[11px] text-slate-400 font-medium">Specialist models will log unexpected data shifts here.</p>
                        </div>
                      )}
                    </div>
                    {activeWorkspace.discoveries.length > 2 && (
                      <button 
                        type="button"
                        onClick={() => setShowAllDiscoveries(!showAllDiscoveries)}
                        className={`text-[9.5px] font-black uppercase tracking-wider mt-3.5 hover:underline flex items-center gap-1 focus:outline-none cursor-pointer ${agentTheme.textClass}`}
                      >
                        {showAllDiscoveries ? 'Show Less ↑' : `Show All (${activeWorkspace.discoveries.length}) ↓`}
                      </button>
                    )}
                  </div>
                </div>

                <div className="md:col-span-5 flex flex-col">
                  <div className="flex flex-col h-full justify-between">
                    <div>
                      <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
                        <span className="flex items-center gap-2">
                          <TrendingUp size={14} className="text-emerald-600" /> Ideas To Try
                        </span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${activeWorkspace.opportunities.length > 0 ? 'bg-emerald-100 text-emerald-700 font-extrabold' : 'bg-slate-100 text-slate-500'}`}>
                          {activeWorkspace.opportunities.length}
                        </span>
                      </h4>
                      {activeWorkspace.opportunities.length > 0 ? (
                        <div className="space-y-3">
                          {(showAllOpportunities ? activeWorkspace.opportunities : activeWorkspace.opportunities.slice(0, 2)).map((f) => (
                            <div key={f.id} data-finding-id={f.id} className={highlightClass(f.id)}>
                              <OpportunityCard finding={f} generating={generatingId === f.id} onGenerate={generateFromFinding} />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="border border-slate-200/60 rounded-2xl p-6 text-center bg-slate-50/40 flex-1 flex flex-col justify-center items-center min-h-[120px] space-y-1">
                          <p className="text-xs font-bold text-slate-600">No Open Opportunities</p>
                          <p className="text-[11px] text-slate-400 font-medium">Growth recommendations will appear after site audit passes.</p>
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
             <div className={`relative border border-dashed rounded-3xl p-10 text-center bg-gradient-to-br from-white to-slate-50/20 ${agentTheme.glowBg} ${agentTheme.glowBorder} overflow-hidden shadow-sm`}>
               {/* Glowing accent circle */}
               <div className={`absolute -right-12 -bottom-12 w-24 h-24 rounded-full blur-2xl opacity-40 ${agentTheme.glowAccent1}`} />
               <div className={`absolute -left-12 -top-12 w-24 h-24 rounded-full blur-2xl opacity-40 ${agentTheme.glowAccent2}`} />
               
               <div className="relative z-10 flex flex-col items-center justify-center">
                 <div className={`w-12 h-12 rounded-2xl grid place-items-center mb-4 shadow-md bg-white border ${agentTheme.glowSoftBorder}`}>
                   <Sparkles size={20} className={`${agentTheme.textClass} animate-pulse`} />
                 </div>
                 <h4 className="text-sm font-black text-slate-800 uppercase tracking-wider mb-1">
                   All Clear
                 </h4>
                 <p className="text-[11.5px] font-bold text-slate-400 max-w-sm leading-relaxed">
                   We checked your {selectedAgent === 'seo' ? 'website SEO' : selectedAgent === 'content' ? 'content' : 'audience insights'} — nothing to fix right now.
                 </p>
               </div>
             </div>
          )}

        </div>
      </div>

      {/* Collapsible Integrations Health Section */}
      {integrations && (
        <section className="border-t border-slate-200 pt-5">
          <button
            onClick={() => setShowIntegrations(!showIntegrations)}
            className="w-full flex items-center justify-between text-xs font-black text-slate-500 uppercase tracking-widest pb-3 cursor-pointer hover:text-slate-800 transition-colors focus:outline-none"
          >
            <span className="flex items-center gap-2">
              <Workflow size={14} className="text-emerald-500" />
              <span>Data Connection Details</span>
            </span>
            {showIntegrations ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {showIntegrations && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pt-4 pb-3 px-4 items-stretch animate-slide-down bg-emerald-500/[0.02] border border-emerald-500/10 rounded-3xl mt-2">
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
          className="w-full flex items-center justify-between text-xs font-black text-slate-505 uppercase tracking-widest pb-3 cursor-pointer hover:text-slate-800 transition-colors focus:outline-none"
        >
          <span className="flex items-center gap-2">
            <History size={14} className="text-indigo-500" />
            <span>Operations History Logs</span>
          </span>
          {showOpsHistory ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>

        {showOpsHistory && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 p-6 items-start animate-slide-down bg-gradient-to-tr from-indigo-50/20 via-transparent to-violet-50/15 border border-indigo-100/50 rounded-[32px] mt-2 shadow-inner">
            
            {/* AI Audit Activity Card */}
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
                  <ActivityFeed items={data?.activity || []} />
                </div>
              </div>
            </div>

            {/* Recent Structural Changes Card */}
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
                  <ChangesTimeline items={data?.recentChanges || []} />
                </div>
              </div>
            </div>
            
          </div>
        )}
      </section>

      {activeDraft && <DraftModal draft={activeDraft} onClose={() => setActiveDraft(null)} onSaved={setActiveDraft} onDeleted={() => setActiveDraft(null)} />}
    </div>
  );
}
