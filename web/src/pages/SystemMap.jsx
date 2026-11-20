import { useState } from 'react';
import { Link } from 'react-router-dom';
import PageIntro from '../components/layout/PageIntro.jsx';
import OrchestrationDiagram from '../components/orchestration/OrchestrationDiagram.jsx';
import AgentDetailPanel from '../components/orchestration/AgentDetailPanel.jsx';
import useLiveAgents from '../hooks/useLiveAgents.js';
import { AGENT_PATH } from '../lib/agent-groups.js';

// The main page of the Agent view: the systems map and nothing else. Live (an agent lights up while it runs). Pressing an agent in
// the map opens its detail; each group's agents, with live status, are one click away in the sidebar.
export default function SystemMap() {
  const { agents, running } = useLiveAgents({ activityLimit: 1 });
  const [selected, setSelected] = useState(null);
  const runningNow = running.size;

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageIntro title="Systems map" subtitle="How your agents work together, from your data to your reports. Pick a group in the sidebar to see its agents." />

      <div className="flex items-center gap-2.5 mb-3 text-[13px] text-text" aria-live="polite">
        <span className="relative w-2 h-2 shrink-0">
          {runningNow > 0 && <span className="absolute inset-0 rounded-full bg-primary animate-ping opacity-60" />}
          <span className={`absolute inset-0 rounded-full ${runningNow > 0 ? 'bg-primary' : 'bg-[#1a7f4b]'}`} />
        </span>
        {runningNow > 0 ? `${runningNow} ${runningNow === 1 ? 'agent is' : 'agents are'} working right now` : 'Everything is quiet. The agents run on their schedule and when you ask.'}
        <Link to={`${AGENT_PATH}?view=console`} className="ml-auto underline underline-offset-2 hover:text-fg">Full run console</Link>
      </div>

      <div className="tray"><div className="tray-card overflow-hidden">
        {agents === null ? (
          <div className="h-[300px] md:h-[680px] bg-muted animate-pulse" />
        ) : agents.length === 0 ? (
          <div className="py-12 text-center text-sm text-faint">No agents available yet.</div>
        ) : (
          <OrchestrationDiagram agents={agents} onSelectAgent={setSelected} runningAgents={running} />
        )}
      </div></div>

      <AgentDetailPanel agent={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
