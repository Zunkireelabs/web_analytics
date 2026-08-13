import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import AnalystGrowthPulse from '../components/AnalystGrowthPulse.jsx';
import AnalystProductCapabilities from '../components/AnalystProductCapabilities.jsx';
import AnalystTopicMap from '../components/AnalystTopicMap.jsx';
import AnalystKeywordOpportunities from '../components/AnalystKeywordOpportunities.jsx';
import AnalystGrowKeyword from '../components/AnalystGrowKeyword.jsx';
import AnalystImpressionForecast from '../components/AnalystImpressionForecast.jsx';
import AnalystChatDrawer from '../components/AnalystChatDrawer.jsx';
import AnalystSkeletonLoader from '../components/AnalystSkeletonLoader.jsx';
import AnalystEmptyState from '../components/AnalystEmptyState.jsx';
import { Activity, AlertTriangle } from 'lucide-react';

// The Analyst agent does three jobs, so this page shows three things,
// full-width and stacked (not squeezed into a two-column layout anymore —
// "Ask the analyst" moved to a floating drawer, see AnalystChatDrawer):
//
//   1. Growth Outlook — the proactive read: where the two headline metrics
//      are forecast to land, and the single most urgent thing to fix before
//      it drops, promoted out of Impression Forecast's own list.
//   2. Keyword Opportunities — what people search for that we could rank for
//      (already-ranking near-page-1 terms), plus Keyword Discovery — net-new
//      topics queued for Action Center, and Grow for a keyword to seed one
//      by hand regardless of what the site profiler has picked up yet.
//   3. Impression Forecast — the full trend chart plus every decline insight
//      found, each with its own real Fix/Dismiss/Send-to-Action-Center
//      controls (Growth Outlook's CTA jumps straight here).
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
      {dashboard === null ? (
        <AnalystSkeletonLoader variant="card" />
      ) : (
        <AnalystGrowthPulse dashboard={dashboard} />
      )}

      <AnalystProductCapabilities clientId={clientId} />

      <AnalystTopicMap clientId={clientId} />

      <AnalystKeywordOpportunities clientId={clientId} refreshToken={keywordRefreshToken} />

      <AnalystGrowKeyword
        clientId={clientId}
        onKeywordQueued={() => setKeywordRefreshToken((n) => n + 1)}
      />

      {dashboard === null ? (
        <AnalystSkeletonLoader variant="card" />
      ) : (
        <AnalystImpressionForecast clientId={clientId} dashboard={dashboard} onChanged={load} />
      )}

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
              Keywords worth growing, and what's about to drop
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
