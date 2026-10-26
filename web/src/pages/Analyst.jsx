import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api, SELF } from '../api.js';
import AnalystBriefing from '../components/AnalystBriefing.jsx';
import AnalystGrowthOutlook from '../components/AnalystGrowthOutlook.jsx';
import AnalystMetricIntelligence from '../components/AnalystMetricIntelligence.jsx';
import AnalystSkeletonLoader from '../components/AnalystSkeletonLoader.jsx';
import AnalystChatDrawer from '../components/AnalystChatDrawer.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import Button from '../components/Button.jsx';
import { STATUS } from '../lib/palette.js';

// Analyst: what is growing, what is about to change, and what the AI found, for THIS project. Every
// client has their own (the workspace switcher changes the project; a platform admin switched into a
// client's project sees that client's). It used to be a staff-only page with a client picker, and its
// keyword sections now live on the Keywords page.
//
// The page reads top to bottom as one decision flow, future first:
//   1. Briefing: one AI-written paragraph orienting the reader.
//   2. Growth outlook: what is happening, and what is predicted next, per forecastable metric.
//   3. What AI found: one card per declining metric: the problem, why, how sure, and the fix, with
//      "Send to Action Center" right on the card.
//
// A platform admin also keeps the staff Admin Assistant here (the cross-client analyst chat), pointed at the
// project they are switched into. Clients use the app-wide Agent panel like on every other page.
export default function Analyst({ siteId, isPlatformAdmin = false }) {
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState(null);
  // Only the newest request may commit its result, so a slow earlier response can never overwrite a newer one.
  const requestRef = useRef(0);

  const load = () => {
    const requestId = ++requestRef.current;
    api.analyst.dashboard(SELF)
      .then((d) => { if (requestRef.current === requestId) setDashboard(d); })
      .catch((e) => { if (requestRef.current === requestId) setError(e.message || 'Failed to load the analyst dashboard'); });
  };
  useEffect(() => { load(); }, []);

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageIntro title="Analyst" subtitle="What's growing, what's about to change, and what the AI found" />

      {error ? (
        <div className="rounded-card px-4 py-3 text-[13px] flex items-center justify-between gap-3"
          style={{ background: STATUS.critical.tint, color: STATUS.critical.text }}>
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle size={16} className="shrink-0" />
            <span>{error}</span>
          </div>
          <Button variant="light" size="sm" className="shrink-0" onClick={() => { setError(null); load(); }}>Retry</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <AnalystBriefing clientId={SELF} />
          {dashboard === null ? (
            <AnalystSkeletonLoader variant="card" />
          ) : (
            <AnalystGrowthOutlook clientId={SELF} dashboard={dashboard} />
          )}
          {dashboard === null ? (
            <AnalystSkeletonLoader variant="card" />
          ) : (
            <AnalystMetricIntelligence clientId={SELF} dashboard={dashboard} onChanged={load} />
          )}
        </div>
      )}

      {isPlatformAdmin && siteId && <AnalystChatDrawer clientId={siteId} dashboard={dashboard} />}
    </div>
  );
}
