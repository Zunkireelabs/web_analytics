import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// Whether the active project has a CONFIRMED industry, and its page data. One read shared by the sidebar (which hides the
// Industry item until it is confirmed) and the page itself. `data` is null while loading or on error: nothing is drawn meanwhile.
const Ctx = createContext({ data: null });

export function IndustryProvider({ siteId, children }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    if (!siteId) return undefined;
    api.industry(siteId).then((d) => { if (!cancelled) setData(d); }).catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [siteId]);
  const value = useMemo(() => ({ data }), [data]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useIndustry = () => useContext(Ctx).data;
