import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, daysAgo } from '../api.js';

// Whether the active project has PostHog connected, and whether THIS person may connect it. One small read shared by
// the sidebar item, the Overview strip and the Behavior tab, so they never disagree. `state` is null until it loads
// (nothing is drawn meanwhile: an unknown state must not flash a "Connect" prompt at someone who is already connected).
const Ctx = createContext({ state: null, refresh: () => Promise.resolve() });

export function PosthogProvider({ siteId, children }) {
  const [state, setState] = useState(null);
  const refresh = useCallback(() => {
    if (!siteId) { setState(null); return Promise.resolve(); }
    // The newest few days: only the flags are used, not the numbers.
    return api.product(daysAgo(3), daysAgo(1))
      .then((r) => setState({ connected: Boolean(r?.connected), status: r?.status || null, canConnect: Boolean(r?.canConnect) }))
      .catch(() => setState(null));
  }, [siteId]);
  useEffect(() => { setState(null); refresh(); }, [refresh]);
  const value = useMemo(() => ({ state, refresh }), [state, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const usePosthogState = () => useContext(Ctx);

// PostHog is offered ONLY to a project that already has it (SuperRank's own); nobody is asked to connect it any more
// (owner decision 2026-11-17). Where "Reconnect PostHog" leads: that project's Connections settings.
export const connectPosthogPath = (siteId) => `/account?scope=project&proj=${siteId}&tab=connections`;
export const POSTHOG_GUIDE_PATH = connectPosthogPath;
