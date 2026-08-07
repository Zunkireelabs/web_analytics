import { getAgent } from './registry.js';
import { saveAgentRun } from '../store/agent-runs.js';
import { emitAgentStart, emitAgentDone } from './lib/activity-bus.js';
import { safeMessage } from '../lib/errors.js';

// The one place that invokes an agent, times it, and persists the result —
// agents themselves never touch agent_runs. Set persist:false for in-process
// composition (see executive-report.js, via orchestrator.js's runOrchestration),
// which still calls runAgent() (so it still goes through here and still fires
// the live activity events below) but skips writing N redundant history rows.
//
// Also the single place that emits real start/done activity events (see
// lib/activity-bus.js) — every real run, whether triggered by a manual click,
// the nightly cron, or the orchestrator's fan-out, passes through here, so
// this is the one spot that can honestly say "an agent actually started/
// finished" for the orchestration page's live diagram.
export async function runAgent(id, input, { persist = true } = {}) {
  const agent = await getAgent(id);
  if (!agent) {
    const err = new Error(`Unknown agent "${id}"`);
    err.status = 404;
    throw err;
  }

  const startedAt = Date.now();
  emitAgentStart(input.siteId, agent.meta.id);
  let output;
  try {
    output = await agent.run(input);
  } catch (err) {
    const tookMs = Date.now() - startedAt;
    emitAgentDone(input.siteId, agent.meta.id, { status: 'error', tookMs });
    if (persist) {
      const { message } = safeMessage(`runner.runAgent:${id}`, err, 'this run did not complete');
      await saveAgentRun({
        siteId: input.siteId, agentId: agent.meta.id, agentVersion: agent.meta.version,
        input, status: 'error', facts: null, narrative: null,
        error: message, tookMs,
      }).catch((e) => console.error(`[agents] failed to log error run for "${id}":`, e.message));
    }
    throw err;
  }

  const tookMs = Date.now() - startedAt;
  emitAgentDone(input.siteId, agent.meta.id, {
    status: output.status || 'ok',
    findingsCount: Array.isArray(output.facts?.findings) ? output.facts.findings.length : 0,
    tookMs,
  });
  if (persist) {
    await saveAgentRun({
      siteId: input.siteId, agentId: agent.meta.id, agentVersion: agent.meta.version,
      input, status: output.status || 'ok', facts: output.facts ?? null,
      narrative: output.narrative ?? null, error: null, tookMs,
    }).catch((e) => console.error(`[agents] failed to persist run for "${id}":`, e.message));
  }

  return { ...output, tookMs };
}
