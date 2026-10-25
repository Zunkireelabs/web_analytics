import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import AnalystBriefing from '../components/AnalystBriefing.jsx';
import AnalystGrowthOutlook from '../components/AnalystGrowthOutlook.jsx';
import AnalystMetricIntelligence from '../components/AnalystMetricIntelligence.jsx';
import AnalystGrowthOpportunities from '../components/AnalystGrowthOpportunities.jsx';
import AnalystProductCapabilities from '../components/AnalystProductCapabilities.jsx';
import AnalystTopicMap from '../components/AnalystTopicMap.jsx';
import AnalystKeywordOpportunities from '../components/AnalystKeywordOpportunities.jsx';
import AnalystGrowKeyword from '../components/AnalystGrowKeyword.jsx';
import AnalystChatDrawer from '../components/AnalystChatDrawer.jsx';
import AnalystSkeletonLoader from '../components/AnalystSkeletonLoader.jsx';
import AnalystEmptyState from '../components/AnalystEmptyState.jsx';
import PageToolbar from '../components/PageToolbar.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import Button from '../components/Button.jsx';
import { STATUS } from '../lib/palette.js';
import UnderlineTabs from '../components/settings/UnderlineTabs.jsx';
import { Activity, AlertTriangle, Gauge, Lightbulb, BookOpen } from 'lucide-react';

// The page is split into three tabs so the first screen is the decision, not a
// 4,000px scroll: Overview (briefing, outlook, what needs attention),
// Opportunities (where to grow) and Evidence (reference the AI cites).
const TABS = [
  { key: 'overview', label: 'Overview', icon: Gauge },
  { key: 'opportunities', label: 'Opportunities', icon: Lightbulb },
  { key: 'evidence', label: 'Evidence', icon: BookOpen },
];

// The page reads top-to-bottom as one AI decision flow, future first:
//
//   1. Briefing — one AI-written paragraph orienting the reader.
//   2. Growth Outlook — what is happening, what is predicted next. Every
//      forecastable headline metric with its projected direction, plus the
//      Past → Today → Forecast chart.
//   3. What AI found — one card per declining METRIC: the problem, why,
//      confidence (real, only where a forecast backs it — see
//      AnalystMetricIntelligence), and the recommended fix, with "Send to
//      Action Center" right on the card. Low-volume noise stays demoted
//      below a fold instead of competing with it.
//   4. Growth Opportunities — where can this site grow next, website-wide,
//      ranked, built from real GSC query+page data + the keyword_gaps queue.
//   5. Keyword Opportunities — AI-discovered (Close to Page 1 + Discovery)
//      plus "Grow a keyword", the user-driven investigate-this-keyword path.
//   6. Evidence — Product Capabilities and the Topic Map, i.e. context for
//      what the site sells and how discovered keywords relate to it. Both
//      start collapsed and load lazily: this is reference material an AI
//      decision can cite, not a decision itself, so it sits last and never
//      competes with sections 2-5 for attention.
//
// Growth Outlook and "What AI found" together replace the old
// AnalystGrowthPulse + AnalystImpressionForecast pair, which split the same
// intelligence across two sections at opposite ends of the page: a metric's
// past decline appeared in one and its forecast decline in the other, with no
// indication they were the same story.
//
// Growth Opportunities (agents/lib/growth-opportunities.js) and the
// Keyword Opportunities section below it both read the exact same
// page1-opportunity data from growth-opportunities.js — there is exactly
// one "close to page 1" definition on this page.
//
// This page previously rendered nine sections wrapped in a personalization
// layer (drag-to-reorder, show/hide toggles, four layout presets, theme and
// density settings, a command palette, a customizer drawer, a shortcuts modal
// and an AI-layout banner). All of that — and the components behind those
// removed sections — has been deleted outright (see the AI Analyst Workspace
// redesign that removed AnalystCommandPalette.jsx, AnalystHeaderOS.jsx,
// AnalystImpressionForecast.jsx, AnalystGrowthPulse.jsx,
// AnalystFindingPipeline.jsx, AnalystInsightCard.jsx,
// AnalystInvestigationWorkspace.jsx and their supporting files): none of it
// was mounted, and keeping dead code on disk "in case it comes back" is how
// this fragmentation happened the first time.

function AnalystBody({ clientId }) {
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState(null);
  // Bumped when the chat queues a new keyword, so the keyword section reloads
  // its gap list without either component knowing about the other.
  const [keywordRefreshToken, setKeywordRefreshToken] = useState(0);
  // Which real integrations THIS client has connected — Growth Opportunities,
  // Topic Map, and Keyword Opportunities below are all functionally built
  // from GSC data (see their own empty-state copy), so a client with no
  // Search Console connected should be told THAT specifically instead of
  // just showing the same generic "nothing here yet" every under-provisioned
  // client sees, indistinguishable from "connected but genuinely quiet."
  const [gscConnected, setGscConnected] = useState(null);
  const [tab, setTab] = useState(() => {
    try { const t = new URLSearchParams(window.location.search).get('tab'); return TABS.some((x) => x.key === t) ? t : 'overview'; } catch { return 'overview'; }
  });
  const changeTab = (t) => {
    setTab(t);
    try { const u = new URL(window.location.href); u.searchParams.set('tab', t); window.history.replaceState(null, '', u); } catch { /* url sync is a convenience */ }
  };

  // Only the newest request may commit its result — switching clients quickly
  // otherwise lets a slower earlier response overwrite the current one.
  const requestRef = useRef(0);

  const load = () => {
    const requestId = ++requestRef.current;
    api.analyst.dashboard(clientId)
      .then((d) => {
        if (requestRef.current !== requestId) return;
        setDashboard(d);
      })
      .catch((e) => {
        if (requestRef.current !== requestId) return;
        setError(e.message || 'Failed to load dashboard');
      });
  };

  useEffect(() => { load(); }, [clientId]);

  useEffect(() => {
    setGscConnected(null);
    api.integrations.health(clientId)
      .then((rows) => {
        const gsc = rows.find((r) => r.id === 'google-oauth');
        setGscConnected(gsc ? gsc.status === 'ok' : null);
      })
      .catch(() => setGscConnected(null));
  }, [clientId]);

  if (error) {
    return (
      <div className="rounded-card px-4 py-3 text-[13px] flex items-center justify-between gap-3"
        style={{ background: STATUS.critical.tint, color: STATUS.critical.text }}>
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle size={16} className="shrink-0" />
          <span>{error}</span>
        </div>
        <Button variant="light" size="sm" className="shrink-0" onClick={() => { setError(null); load(); }}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div>
      <UnderlineTabs tabs={TABS} value={tab} onChange={changeTab} />

      <div className="space-y-3 mt-4">
        {gscConnected === false && tab !== 'overview' && (
          <div className="rounded-card px-4 py-3 text-[13px] flex items-center gap-2"
            style={{ background: STATUS.warning.tint, color: STATUS.warning.text }}>
            <AlertTriangle size={14} className="shrink-0" />
            <span>Search Console isn't connected for this client — Growth Opportunities, Topic Map, and Keyword Opportunities will stay empty until it is.</span>
          </div>
        )}

        {tab === 'overview' && (
          <>
            <AnalystBriefing clientId={clientId} />
            {dashboard === null ? (
              <AnalystSkeletonLoader variant="card" />
            ) : (
              <AnalystGrowthOutlook clientId={clientId} dashboard={dashboard} />
            )}
            {dashboard === null ? (
              <AnalystSkeletonLoader variant="card" />
            ) : (
              <AnalystMetricIntelligence clientId={clientId} dashboard={dashboard} onChanged={load} />
            )}
          </>
        )}

        {tab === 'opportunities' && (
          <>
            <AnalystGrowthOpportunities clientId={clientId} />
            <AnalystKeywordOpportunities clientId={clientId} refreshToken={keywordRefreshToken} />
            <AnalystGrowKeyword
              clientId={clientId}
              onKeywordQueued={() => setKeywordRefreshToken((n) => n + 1)}
            />
          </>
        )}

        {tab === 'evidence' && (
          <>
            <p className="px-1 text-xs text-faint">What the site sells, and how discovered keywords relate to it</p>
            <AnalystProductCapabilities clientId={clientId} />
            <AnalystTopicMap clientId={clientId} />
          </>
        )}
      </div>

      <AnalystChatDrawer clientId={clientId} dashboard={dashboard} />
    </div>
  );
}

export default function Analyst() {
  const [clients, setClients] = useState(null);
  const [clientId, setClientId] = useState(null);

  useEffect(() => {
    api.clients.list()
      .then((list) => {
        const active = (list || []).filter((c) => c.status === 'active');
        setClients(active);
        if (active.length) setClientId((prev) => prev ?? active[0].id);
      })
      .catch(() => setClients([]));
  }, []);

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      {clients?.length > 0 && (
        <PageToolbar>
          <label className="flex items-center gap-2 text-[13px] text-text w-full md:w-auto">
            <span className="shrink-0">Client</span>
            <select
              value={clientId ?? ''}
              onChange={(e) => setClientId(Number(e.target.value))}
              className="h-8 flex-1 md:flex-none min-w-0 rounded-control bg-white text-[13px] text-fg px-2.5 outline-none cursor-pointer"
              style={{ boxShadow: '0 0 0 1px var(--input)' }}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name || c.domain || `Client #${c.id}`}</option>
              ))}
            </select>
          </label>
        </PageToolbar>
      )}

      <PageIntro title="Analyst" subtitle="What's growing, what's about to change, and where this site can grow next" />

      {clients === null ? (
        <AnalystSkeletonLoader variant="hero" />
      ) : clients.length === 0 ? (
        <AnalystEmptyState
          icon={Activity}
          title="No Active Clients Onboarded"
          description="Onboard your first site in Platform Administration to start tracking keywords and forecasts."
        />
      ) : clientId ? (
        <AnalystBody key={clientId} clientId={clientId} />
      ) : null}
    </div>
  );
}
