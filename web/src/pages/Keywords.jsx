import { useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, FileText, Hash } from 'lucide-react';
import { api, SELF } from '../api.js';
import AnalystProductCapabilities from '../components/AnalystProductCapabilities.jsx';
import AnalystTopicMap from '../components/AnalystTopicMap.jsx';
import KeywordsTab from '../components/keywords/KeywordsTab.jsx';
import PagesTab from '../components/keywords/PagesTab.jsx';
import PageIntro from '../components/layout/PageIntro.jsx';
import UnderlineTabs from '../components/settings/UnderlineTabs.jsx';
import { STATUS } from '../lib/palette.js';

// Keywords, for every client's own project (clientId SELF: the server takes the site from the session,
// never from the URL):
//
//   Keywords      what the site already ranks for, what people search that it has no page for, and adding
//                 a keyword of your own, which asks whether to make a blog post, a landing page, or just track it
//   Pages         which keywords each page ranks for, and which pages rank for nothing
//   What you sell product projects only: what the product does and who it is sold to, which the agent reads to
//                 judge whether a keyword fits it and which keywords belong to which capability
export default function Keywords({ isProduct = false }) {
  // Everything here is built from Search Console data, so a project with none connected is told that
  // specifically instead of looking like a quiet site.
  const [gscConnected, setGscConnected] = useState(null);
  const tabs = [
    { key: 'keywords', label: 'Keywords', icon: Hash },
    { key: 'pages', label: 'Pages', icon: FileText },
    ...(isProduct ? [{ key: 'topics', label: 'What you sell', icon: BookOpen }] : []),
  ];
  const [tab, setTab] = useState(() => {
    try { const t = new URLSearchParams(window.location.search).get('tab'); return tabs.some((x) => x.key === t) ? t : 'keywords'; } catch { return 'keywords'; }
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
      <PageIntro title="Keywords" subtitle="The keywords you have, the ones you could win, and which pages they land on" />
      <UnderlineTabs tabs={tabs} value={tab} onChange={changeTab} />

      <div className="space-y-3 mt-4">
        {gscConnected === false && (
          <div className="rounded-card px-4 py-3 text-[13px] flex items-center gap-2"
            style={{ background: STATUS.warning.tint, color: STATUS.warning.text }}>
            <AlertTriangle size={14} className="shrink-0" />
            <span>Search Console isn't connected for this project, so the numbers below stay empty until it is.</span>
          </div>
        )}

        {tab === 'keywords' && <KeywordsTab isProduct={isProduct} />}
        {tab === 'pages' && <PagesTab />}
        {tab === 'topics' && isProduct && (
          <>
            <p className="px-1 text-xs text-faint">What the product does and who it is sold to. The agent reads this to judge which keywords fit.</p>
            <AnalystProductCapabilities clientId={SELF} />
            <AnalystTopicMap clientId={SELF} />
          </>
        )}
      </div>
    </div>
  );
}
