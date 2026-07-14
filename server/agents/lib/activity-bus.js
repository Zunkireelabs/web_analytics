import { EventEmitter } from 'events';

// One process-wide bus every real agent run passes through — runner.js
// (agents/runner.js) is the single choke point ALL real runs already go
// through (a manual click on the orchestration page, the nightly cron in
// cron.js, or the orchestrator's 10-agent fan-out in orchestrator.js), so
// instrumenting it here means any open SSE connection (routes/agents.js GET
// /agents/live) sees genuine system activity, not just what that one tab
// triggered. Nothing here is simulated — every event corresponds to a real
// runAgent() call that actually started or actually finished.
const bus = new EventEmitter();
bus.setMaxListeners(200); // one listener per open browser tab watching a site's activity

export function emitAgentStart(siteId, agentId) {
  if (!siteId) return;
  bus.emit('activity', { siteId, type: 'start', agentId, at: new Date().toISOString() });
}

export function emitAgentDone(siteId, agentId, { status, findingsCount = 0, tookMs = null }) {
  if (!siteId) return;
  bus.emit('activity', { siteId, type: 'done', agentId, status, findingsCount, tookMs, at: new Date().toISOString() });
}

// Returns an unsubscribe function. Filters to one site's events so an open
// tab only ever sees its own site's real activity, never another client's.
export function subscribeActivity(siteId, handler) {
  const listener = (event) => { if (event.siteId === siteId) handler(event); };
  bus.on('activity', listener);
  return () => bus.off('activity', listener);
}
