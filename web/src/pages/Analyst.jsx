import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, SELF } from '../api.js';
import PageIntro from '../components/layout/PageIntro.jsx';
import UnderlineTabs from '../components/settings/UnderlineTabs.jsx';
import AnalystChatDrawer from '../components/AnalystChatDrawer.jsx';
import OutlookTab from '../components/analyst/OutlookTab.jsx';
import FixesTab from '../components/analyst/FixesTab.jsx';
import Badge from '../components/Badge.jsx';
import { fixesBadge } from '../lib/analyst-view.js';

// Analyst: what the AI expects next week, and what it is already fixing, for THIS project. Two subpages:
//   Outlook: next week's clicks and impressions as a range, keywords that can grow, what is shifting.
//   Fixes:   problems from predicted to fixed, and what each fix really did once it was measured.
// Every client has their own (the workspace switcher changes the project). A platform admin also keeps the staff
// Admin Assistant here, pointed at the project they are switched into, and sees what the shared model has learned.
export default function Analyst({ siteId, isPlatformAdmin = false }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'fixes' ? 'fixes' : 'outlook';
  const setTab = (t) => setParams(t === 'fixes' ? { tab: 'fixes' } : {}, { replace: true });

  const [outlook, setOutlook] = useState(null);      // null = loading
  const [fixes, setFixes] = useState(null);
  const [outlookError, setOutlookError] = useState(null);
  const [fixesError, setFixesError] = useState(null);
  const [approving, setApproving] = useState(false);
  const [dashboard, setDashboard] = useState(null);  // only the staff chat drawer needs it
  // Only the newest request may commit, so a slow earlier response never overwrites a newer one.
  const outlookReq = useRef(0), fixesReq = useRef(0);

  const loadOutlook = useCallback(() => {
    const id = ++outlookReq.current;
    setOutlookError(null);
    api.analyst.outlook()
      .then((d) => { if (outlookReq.current === id) setOutlook(d); })
      .catch((e) => { if (outlookReq.current === id) setOutlookError(e.message || 'Could not load the outlook'); });
  }, []);
  // keepError: the refresh that follows a FAILED approval must not wipe the message that explains the failure.
  const loadFixes = useCallback(({ keepError = false } = {}) => {
    const id = ++fixesReq.current;
    if (!keepError) setFixesError(null);
    api.analyst.fixes()
      .then((d) => { if (fixesReq.current === id) setFixes(d); })
      .catch((e) => { if (fixesReq.current === id) setFixesError(e.message || 'Could not load the fixes'); });
  }, []);

  // Both load up front so the Fixes tab badge is right before it is opened.
  useEffect(() => { loadOutlook(); loadFixes(); }, [loadOutlook, loadFixes]);
  useEffect(() => {
    if (!(isPlatformAdmin && siteId)) return;
    api.analyst.dashboard(SELF).then(setDashboard).catch(() => {});
  }, [isPlatformAdmin, siteId]);

  async function approve(id) {
    setApproving(true);
    let failed = false;
    try { await api.analyst.approveFix(id); } catch (e) { failed = true; setFixesError(e.message || 'Could not approve that fix'); }
    finally { setApproving(false); loadFixes({ keepError: failed }); loadOutlook(); }
  }

  const badge = fixesBadge(fixes?.counts);
  const tabs = [
    { key: 'outlook', label: 'Outlook' },
    { key: 'fixes', label: badge ? <>Fixes <Badge tone="red">{badge}</Badge></> : 'Fixes' },
  ];

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageIntro title="Analyst" subtitle="What the AI expects next week, and what it is already fixing" />
      <div className="-mt-2 mb-4"><UnderlineTabs tabs={tabs} value={tab} onChange={setTab} /></div>

      {tab === 'outlook' ? (
        <OutlookTab outlook={outlook} loading={outlook === null && !outlookError} error={outlookError} onRetry={loadOutlook}
          onSeeFixes={() => setTab('fixes')} isPlatformAdmin={isPlatformAdmin} />
      ) : (
        <FixesTab fixes={fixes} loading={fixes === null && !fixesError} error={fixesError} onRetry={() => loadFixes()} onApprove={approve} approving={approving} />
      )}

      {isPlatformAdmin && siteId && <AnalystChatDrawer clientId={siteId} dashboard={dashboard} />}
    </div>
  );
}
