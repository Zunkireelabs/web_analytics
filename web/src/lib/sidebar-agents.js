// Turns GET /agents/status rows plus the live `running` map (agentId -> start ms) into the sidebar's agent list.
// Order: running now (longest-running first), then failed, then by most recent run, then never run.
// state: 'running' | 'failed' | 'done' | 'idle'. A row is 'running' only from the live map, never guessed from old runs.
const RANK = { running: 0, failed: 1, done: 2, idle: 3 };

export function agentState(agent, running) {
  if (running?.has(agent.id)) return 'running';
  if (!agent.lastRunStatus) return 'idle';
  if (agent.lastRunStatus === 'error') return 'failed';
  return 'done';
}

export function orderAgentsForSidebar(agents, running) {
  return (agents || [])
    .map((a) => ({ ...a, state: agentState(a, running), since: running?.get(a.id) ?? null }))
    .sort((a, b) => {
      if (RANK[a.state] !== RANK[b.state]) return RANK[a.state] - RANK[b.state];
      if (a.state === 'running') return a.since - b.since;
      const ta = a.lastRunAt ? new Date(a.lastRunAt).getTime() : 0;
      const tb = b.lastRunAt ? new Date(b.lastRunAt).getTime() : 0;
      return tb - ta || String(a.name).localeCompare(String(b.name));
    });
}
