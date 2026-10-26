import { useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, Lightbulb } from 'lucide-react';
import { api, SELF } from '../api.js';
import AnalystGrowthOpportunities from '../components/AnalystGrowthOpportunities.jsx';
import AnalystKeywordOpportunities from '../components/AnalystKeywordOpportunities.jsx';
import AnalystGrowKeyword from '../components/AnalystGrowKeyword.jsx';
import AnalystProductCapabilities from '../components/AnalystProductCapabilities.jsx';
import AnalystTopicMap from '../components/AnalystTopicMap.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import UnderlineTabs from '../components/settings/UnderlineTabs.jsx';
import { STATUS } from '../lib/palette.js';

// Keywords: the searches this site can win, and the topics it covers. These sections used to sit
// on the Analyst page, which only staff could open; every client now has them for their own
// project (clientId SELF: the server takes the site from the session, never from the URL).
//
//   Opportunities       where this site can grow next, keywords close to page one, and "Grow a keyword"
//   Topics and product  what the site sells, and how the keywords found relate to it
const TABS = [
  { key: 'opportunities', label: 'Opportunities', icon: Lightbulb },
  { key: 'topics', label: 'Topics and product', icon: BookOpen },
];

export default function Keywords() {
  // Bumped when a keyword is queued, so the list reloads its gaps without the two components knowing each other.
  const [refreshToken, setRefreshToken] = useState(0);
  // Growth opportunities, keywords and the topic map are all built from Search Console data, so a project with
  // none connected is told that specifically instead of looking like a quiet site.
  const [gscConnected, setGscConnected] = useState(null);
  const [tab, setTab] = useState(() => {
    try { const t = new URLSearchParams(window.location.search).get('tab'); return TABS.some((x) => x.key === t) ? t : 'opportunities'; } catch { return 'opportunities'; }
  });
  const changeTab = (t) => {
    setTab(t);
    try { const u = new URL(window.location.href); u.searchParams.set('tab', t); window.history.replaceState(null, '', u); } catch { /* the URL is a convenience */ }
  };

  useEffect(() => {
    api.analyst.connections().then((r) => setGscConnected(r.gscConnected)).catch(() => setGscConnected(null));
  }, []);

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageIntro title="Keywords" subtitle="The searches you can win next, and the topics your site covers" />
      <UnderlineTabs tabs={TABS} value={tab} onChange={changeTab} />

      <div className="space-y-3 mt-4">
        {gscConnected === false && (
          <div className="rounded-card px-4 py-3 text-[13px] flex items-center gap-2"
            style={{ background: STATUS.warning.tint, color: STATUS.warning.text }}>
            <AlertTriangle size={14} className="shrink-0" />
            <span>Search Console isn't connected for this project, so growth opportunities, keywords and the topic map stay empty until it is.</span>
          </div>
        )}

        {tab === 'opportunities' && (
          <>
            <AnalystGrowthOpportunities clientId={SELF} />
            <AnalystKeywordOpportunities clientId={SELF} refreshToken={refreshToken} />
            <AnalystGrowKeyword clientId={SELF} onKeywordQueued={() => setRefreshToken((n) => n + 1)} />
          </>
        )}

        {tab === 'topics' && (
          <>
            <p className="px-1 text-xs text-faint">What the site sells, and how discovered keywords relate to it</p>
            <AnalystProductCapabilities clientId={SELF} />
            <AnalystTopicMap clientId={SELF} />
          </>
        )}
      </div>
    </div>
  );
}
