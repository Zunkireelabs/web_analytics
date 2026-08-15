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
import { Activity, AlertTriangle } from 'lucide-react';

// The page reads top-to-bottom as one argument, future first:
//
//   1. Growth Outlook — the hero. Every forecastable headline metric (not
//      just impressions and clicks) with its projected direction, plus the
//      Past → Today → Forecast chart, promoted here from the bottom of the
//      page where it used to be buried inside Impression Forecast.
//   2. What needs attention — one card per METRIC, merging the observed
//      decline, the projected one, the root cause and the fix into a single
//      story, with the low-volume noise demoted below a fold.
//   3. Growth Opportunities — website-wide, ranked, built from real GSC
//      query+page data + the keyword_gaps queue (not the stale 14-day
//      keyword_clusters snapshot). Answers "where can this site grow next?"
//      without requiring a keyword to already be picked.
//   4. Product Capabilities / Topic Map — context for what the site sells.
//   5. Keyword Opportunities (Close to Page 1 + Discovery) + Grow a keyword.
//
// Growth Outlook and What-needs-attention together replace the old
// AnalystGrowthPulse + AnalystImpressionForecast pair, which split the same
// intelligence across two sections at opposite ends of the page: a metric's
// past decline appeared in one and its forecast decline in the other, with no
// indication they were the same story.
//
// Growth Opportunities (agents/lib/growth-opportunities.js) and the older
// Keyword Opportunities section below it currently have two SEPARATE
// "close to page 1" views — the older one still reads the stale
// keyword_clusters snapshot. Rewiring it onto the same canonical model is
// the next phase, not done here.
//
// This page previously rendered nine sections wrapped in a personalization
// layer (drag-to-reorder, show/hide toggles, four layout presets, theme and
// density settings, a command palette, a customizer drawer, a shortcuts modal
// and an AI-layout banner). All of it is gone. The components behind the
// removed sections are still on disk, just no longer mounted — nothing was
// deleted, so any of them can be brought back by importing it again.

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
      <div className="an-panel p-5 border-rose-500/30 bg-rose-500/[0.06] text-rose-600 font-semibold text-xs flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle size={16} className="shrink-0" />
          <span>{error}</span>
        </div>
        <button
          type="button"
          onClick={() => { setError(null); load(); }}
          className="px-3 py-1 rounded-xl bg-slate-100 border border-rose-400/30 text-rose-600 text-xs font-bold hover:bg-slate-200 transition shrink-0 cursor-pointer"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AnalystBriefing clientId={clientId} />

      {gscConnected === false && (
        <div className="an-panel p-4 border-amber-300/50 bg-amber-50/60 text-amber-800 text-xs font-semibold flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0" />
          <span>Search Console isn't connected for this client — Growth Opportunities, Topic Map, and Keyword Opportunities below will stay empty until it is.</span>
        </div>
      )}

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

      <AnalystGrowthOpportunities clientId={clientId} />

      <AnalystProductCapabilities clientId={clientId} />

      <AnalystTopicMap clientId={clientId} />

      <AnalystKeywordOpportunities clientId={clientId} refreshToken={keywordRefreshToken} />

      <AnalystGrowKeyword
        clientId={clientId}
        onKeywordQueued={() => setKeywordRefreshToken((n) => n + 1)}
      />

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
    <div className="analyst-root min-h-screen">
      <div
        className="fixed inset-0 pointer-events-none -z-10"
        style={{
          background:
            'radial-gradient(900px 420px at 8% -5%, rgba(108,99,255,0.10), transparent 55%),' +
            'radial-gradient(700px 380px at 95% -8%, rgba(6,182,212,0.07), transparent 55%),' +
            'linear-gradient(180deg,#f7f8fc 0%,#eef1f6 55%,#f7f8fc 100%)',
        }}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-black text-slate-900 tracking-tight">Analyst</h1>
            <p className="text-xs font-medium text-slate-500 mt-0.5">
              What's growing, what's about to change, and where this site can grow next
            </p>
          </div>

          {clients?.length > 0 && (
            <label className="flex items-center gap-2">
              <span className="an-label">Client</span>
              <select
                value={clientId ?? ''}
                onChange={(e) => setClientId(Number(e.target.value))}
                className="an-input text-xs font-bold py-2 pr-8 cursor-pointer"
              >
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name || c.domain || `Client #${c.id}`}</option>
                ))}
              </select>
            </label>
          )}
        </div>

        {clients === null ? (
          <div className="py-12">
            <AnalystSkeletonLoader variant="hero" />
          </div>
        ) : clients.length === 0 ? (
          <div className="py-12">
            <AnalystEmptyState
              icon={Activity}
              title="No Active Clients Onboarded"
              description="Onboard your first site in Platform Administration to start tracking keywords and forecasts."
            />
          </div>
        ) : clientId ? (
          <AnalystBody key={clientId} clientId={clientId} />
        ) : null}
      </div>
    </div>
  );
}
