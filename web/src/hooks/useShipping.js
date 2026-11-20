import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

// Where the shipping flow is for fixes and for content (from the server, which reads the drafts and PRs themselves), checked on load and
// every 30 seconds. The agent popup asks the next question from this; it is never kept on the pages themselves.
export default function useShipping(siteId, { enabled = true } = {}) {
  const [state, setState] = useState({ fixes: null, content: null });
  const reload = useCallback(() => {
    if (!siteId) return Promise.resolve();
    return Promise.all(['fixes', 'content'].map((scope) => api.actionCenter.shipState(scope, undefined).then((s) => [scope, s]).catch(() => [scope, null])))
      .then((rows) => setState(Object.fromEntries(rows)));
  }, [siteId]);
  useEffect(() => {
    setState({ fixes: null, content: null });
    if (!enabled || !siteId) return undefined;
    reload();
    const t = setInterval(reload, 30000);
    return () => clearInterval(t);
  }, [siteId, enabled, reload]);
  return { ...state, reload };
}
