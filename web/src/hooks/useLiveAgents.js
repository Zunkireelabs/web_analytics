import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const FALLBACK_POLL_MS = 45000;

// The live state of a site's agents, shared by the sidebar's Agent view and the Agents page (AiGrowth.jsx), so both read
// the same feed the same way:
//   agents   GET /agents/status: every agent with its last real run (status, time, findings)
//   activity GET /agents/activity: recent runs, newest first
//   running  Map(agentId -> start ms) of what is running right now, from the /agents/live SSE stream. The stream opens
//            with a snapshot of what is already running, then sends a start or done event for every real run.
// The SSE stream is the live signal; the 45s poll only covers a dropped stream. `onEvent` lets a page react to each
// start/done event (the Agents page writes its console log from it) without opening a second stream.
export default function useLiveAgents({ activityLimit = 12, onEvent, enabled = true } = {}) {
  const [agents, setAgents] = useState(null);
  const [activity, setActivity] = useState(null);
  const [running, setRunning] = useState(() => new Map());
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  const agentsRef = useRef([]);
  useEffect(() => { agentsRef.current = agents || []; }, [agents]);

  const refresh = useCallback(() => {
    api.agentsStatus().then(setAgents).catch(() => setAgents((a) => a ?? []));
    api.agentsActivity(activityLimit).then(setActivity).catch(() => setActivity((a) => a ?? []));
  }, [activityLimit]);

  useEffect(() => {
    if (!enabled) return undefined;
    refresh();
    const poll = setInterval(refresh, FALLBACK_POLL_MS);
    return () => clearInterval(poll);
  }, [refresh, enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const es = new EventSource(`${import.meta.env.BASE_URL}api/agents/live`);
    es.onmessage = (raw) => {
      let event;
      try { event = JSON.parse(raw.data); } catch { return; }
      if (event.type === 'snapshot') {
        setRunning(new Map((event.running || []).map((r) => [r.agentId, new Date(r.at).getTime()])));
        return;
      }
      const label = agentsRef.current.find((a) => a.id === event.agentId)?.name || event.agentId;
      if (event.type === 'start') {
        setRunning((m) => new Map(m).set(event.agentId, new Date(event.at).getTime()));
      } else if (event.type === 'done') {
        setRunning((m) => {
          if (!m.has(event.agentId)) return m;
          const next = new Map(m);
          next.delete(event.agentId);
          return next;
        });
        refresh();
      }
      onEventRef.current?.(event, label);
    };
    return () => es.close();
  }, [refresh, enabled]);

  return { agents, activity, running, refresh };
}
