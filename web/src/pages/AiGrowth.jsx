import { useCallback, useEffect, useState } from 'react';
import { api, daysAgo } from '../api.js';
import OrchestrationDiagram from '../components/orchestration/OrchestrationDiagram.jsx';
import AgentDetailPanel from '../components/orchestration/AgentDetailPanel.jsx';
import LiveActivityRail from '../components/orchestration/LiveActivityRail.jsx';

const FALLBACK_POLL_MS = 45000; // safety net only — the SSE stream below is the real live signal
const REFRESH_START = daysAgo(7);
const REFRESH_END = daysAgo(0);

// A real systems map of the real orchestrator (server/agents/orchestrator.js
// + runner.js), not a static "click to simulate" diagram. runner.js is the
// one place every real agent run passes through — a manual click here, the
// nightly cron (server/cron.js), or the orchestrator's parallel fan-out
// behind Command Center/Executive Report — so it's instrumented to emit
// real start/done events (agents/lib/activity-bus.js) that this page
// subscribes to over SSE (GET /agents/live). That's what "live" means here:
// nodes pulse in the real order/parallelism agents actually run in, driven
// by genuine events, never a decorative animation loop.
export default function AiGrowth() {
  const [agents, setAgents] = useState(null); // null = loading
  const [activity, setActivity] = useState(null);
  const [selected, setSelected] = useState(null);
  const [runningAgents, setRunningAgents] = useState(new Map()); // agentId -> startedAt (ms)
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);

  const refresh = useCallback(() => {
    api.agentsStatus().then(setAgents).catch(() => setAgents((a) => a ?? []));
    api.agentsActivity(12).then(setActivity).catch(() => setActivity((a) => a ?? []));
  }, []);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, FALLBACK_POLL_MS);
    return () => clearInterval(poll);
  }, [refresh]);

  // The real live signal — every event here corresponds to an actual
  // runAgent() call in flight somewhere in the system, for this site only.
  useEffect(() => {
    const es = new EventSource('/api/agents/live');
    es.onmessage = (raw) => {
      let event;
      try { event = JSON.parse(raw.data); } catch { return; }
      if (event.type === 'start') {
        setRunningAgents((m) => new Map(m).set(event.agentId, new Date(event.at).getTime()));
      } else if (event.type === 'done') {
        setRunningAgents((m) => {
          if (!m.has(event.agentId)) return m;
          const next = new Map(m);
          next.delete(event.agentId);
          return next;
        });
        refresh(); // pull the just-persisted run in immediately, don't wait for the fallback poll
      }
    };
    return () => es.close();
  }, [refresh]);

  const runAll = async () => {
    setRefreshing(true); setRefreshError(null);
    try {
      await api.commandCenter.refresh(REFRESH_START, REFRESH_END);
    } catch (e) {
      setRefreshError(e.message || 'Run failed');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden"
      style={{ background: 'linear-gradient(180deg, #263a63 0%, #22345c 45%, #1c2c50 100%)' }}>
      {/* Deep indigo ambient glow — same #6C63FF/#8b5cf6 brand hues as the
          light theme's ambient blobs (App.jsx), just brighter against dark
          so this page reads as this app's dark mode, not a generic black
          screen borrowed from somewhere else. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-0">
        <div className="absolute -top-40 left-1/4 w-[640px] h-[640px] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(108,99,255,0.22), transparent 60%)' }} />
        <div className="absolute top-1/3 -right-40 w-[560px] h-[560px] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.16), transparent 60%)' }} />
        <div className="absolute bottom-0 left-1/3 w-[520px] h-[520px] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.14), transparent 60%)' }} />
      </div>

      <div className="relative max-w-[1400px] mx-auto px-4 sm:px-6 md:px-10 py-10">
        {/* Live Activity docks top-right of the page section, above/outside
            the canvas — it used to float as a React Flow Panel on top of the
            graph, but that put it inside the same coordinate space as the
            nodes, which kept colliding with whichever column ended up
            underneath it. A real grid column here can't overlap the canvas
            by construction. */}
        <div className="grid lg:grid-cols-3 gap-6 mb-6 items-start">
          <div className="lg:col-span-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-white/50 px-3 py-1 rounded-full mb-4"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}>
              🕸️ Agent Orchestration
            </span>
            <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">How your AI analyst is actually built.</h1>
            <p className="text-sm text-white/45 mt-2 max-w-xl leading-relaxed">
              10 specialist agents run independently and in parallel over the same real data, persist to one shared
              store, and feed Command Center, Action Center, and one synthesized executive narrative. This view is
              live — it reacts to any real run, whether triggered below, by the nightly cron, or elsewhere in the app.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <button type="button" onClick={runAll} disabled={refreshing}
                className="text-xs font-semibold px-4 py-2 rounded-lg text-white transition disabled:opacity-60"
                style={{ background: '#6C63FF' }}>
                {refreshing ? 'Running all agents…' : '▶ Run all agents now'}
              </button>
              {runningAgents.size > 0 && (
                <span className="text-[11px] font-mono text-white/45">{runningAgents.size} agent{runningAgents.size > 1 ? 's' : ''} running live…</span>
              )}
              {refreshError && <span className="text-[11px] text-rose-300">{refreshError}</span>}
            </div>
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

      <AgentDetailPanel agent={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
