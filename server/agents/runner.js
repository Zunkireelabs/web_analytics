import { getAgent } from './registry.js';
import { saveAgentRun } from '../store/agent-runs.js';

// The one place that invokes an agent, times it, and persists the result —
// agents themselves never touch agent_runs. Set persist:false for in-process
// composition (see executive-report.js), which calls agent.run() directly
// instead of going through here, to avoid writing N redundant history rows.
export async function runAgent(id, input, { persist = true } = {}) {
  const agent = await getAgent(id);
  if (!agent) {
    const err = new Error(`Unknown agent "${id}"`);
    err.status = 404;
    throw err;
  }

  const startedAt = Date.now();
  let output;
  try {
    output = await agent.run(input);
  } catch (err) {
    if (persist) {
      await saveAgentRun({
        siteId: input.siteId, agentId: agent.meta.id, agentVersion: agent.meta.version,
        input, status: 'error', facts: null, narrative: null,
        error: String(err?.message || err), tookMs: Date.now() - startedAt,
      }).catch((e) => console.error(`[agents] failed to log error run for "${id}":`, e.message));
    }
    throw err;
  }

  const tookMs = Date.now() - startedAt;
  if (persist) {
    await saveAgentRun({
      siteId: input.siteId, agentId: agent.meta.id, agentVersion: agent.meta.version,
      input, status: output.status || 'ok', facts: output.facts ?? null,
      narrative: output.narrative ?? null, error: null, tookMs,
    }).catch((e) => console.error(`[agents] failed to persist run for "${id}":`, e.message));
  }

  return { ...output, tookMs };
}
