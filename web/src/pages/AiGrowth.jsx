import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import AgentCard from '../components/AgentCard.jsx';

function AgentCardSkeleton() {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <div className="w-10 h-10 rounded-xl bg-slate-100 animate-pulse" />
        <div className="h-4 w-20 bg-slate-100 rounded-full animate-pulse" />
      </div>
      <div className="h-4 w-32 bg-slate-200 rounded animate-pulse mt-4" />
      <div className="h-3 w-full bg-slate-100 rounded animate-pulse mt-2.5" />
      <div className="h-3 w-2/3 bg-slate-100 rounded animate-pulse mt-1.5" />
      <div className="h-5 w-16 bg-slate-100 rounded-full animate-pulse mt-5" />
    </div>
  );
}

// No siteId prop — the agent registry isn't site-scoped (same shape as Home.jsx).
export default function AiGrowth() {
  const [agents, setAgents] = useState(null); // null = loading

  useEffect(() => {
    api.agents().then(setAgents).catch(() => setAgents([]));
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <PageHeader
        title="AI Growth"
        subtitle="Run any agent for a real analysis of the last 7 days — actionable findings live in Action Center"
        icon="🤖"
      />

      {agents !== null && agents.length === 0 ? (
        <div className="card p-8 text-center text-slate-400">No agents available yet.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents === null
            ? Array.from({ length: 7 }).map((_, i) => <AgentCardSkeleton key={i} />)
            : agents.map((a) => <AgentCard key={a.id} agent={a} />)}
        </div>
      )}
    </div>
  );
}
