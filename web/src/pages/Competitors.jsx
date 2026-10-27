import { useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { api } from '../api.js';
import PageIntro from '../components/layout/PageIntro.jsx';
import { Tray } from '../components/layout/Tray.jsx';
import StandingCards from '../components/competitors/StandingCards.jsx';
import CompetitorCard from '../components/competitors/CompetitorCard.jsx';
import { buildCompetitorView, buildStory } from '../lib/competitor-view.js';

// Competitors: who this site is up against, and in which ways each one is ahead. Plain words first
// (the numbers have meanings spelled out), then one card per competitor. All of it is real,
// already-persisted agent output; a measure with no data for a competitor is simply not shown.
export default function Competitors() {
  const [ccData, setCcData] = useState(null); // null = loading
  const [backlinks, setBacklinks] = useState(null); // null = loading

  useEffect(() => {
    let cancelled = false;
    api.commandCenter.get().then((d) => { if (!cancelled) setCcData(d); }).catch(() => { if (!cancelled) setCcData({}); });
    // The referring-domain summary for this project's OWN domain (the server takes it from the session).
    api.commonCrawlBacklinks.summaryOwn().then((d) => { if (!cancelled) setBacklinks(d); })
      .catch(() => { if (!cancelled) setBacklinks({ status: 'insufficient-data' }); });
    return () => { cancelled = true; };
  }, []);

  const view = useMemo(() => buildCompetitorView({
    competitors: ccData?.competitors || [],
    backlinkComparison: ccData?.backlinkComparison || null,
    rankingComparison: ccData?.rankingComparison || null,
  }), [ccData]);
  const story = buildStory(view);
  const loading = ccData === null;
  // Prefer the standalone summary of this site's own link count; fall back to the comparison's own side.
  const ownLinks = backlinks?.status === 'ok' ? backlinks.referringDomains : view.ownLinks;

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageIntro title="Competitors" subtitle="Who you are up against, and how you compare online" />

      {story && (
        <div className="tray">
          <div className="tray-card">
            <div className="px-5 py-4 flex items-start gap-3">
              <span className="w-8 h-8 rounded-control bg-primary-tint text-primary grid place-items-center shrink-0" style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}><Info size={16} /></span>
              <div>
                <h2 className="text-[15px] font-semibold text-fg">Where you stand, in plain words</h2>
                <p className="text-[14px] leading-[22px] text-text mt-1">{story}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      <StandingCards authority={ccData?.authority} authorityMeta={ccData?.authorityMeta} ownLinks={ownLinks} view={view} loading={loading || backlinks === null} />

      <Tray className="mt-3" title="Who your competitors are, and where they are ahead" subtitle="Red means they are ahead of you. Green means you lead">
        {loading ? (
          <div className="tray-card px-4 py-10 text-sm text-faint text-center">Loading competitors…</div>
        ) : !view.cards.length ? (
          <div className="tray-card px-4 py-10 text-sm text-faint text-center">No competitors logged yet.</div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 items-start col-span-full">
            {view.cards.map((c) => <CompetitorCard key={c.id ?? c.domain} card={c} />)}
          </div>
        )}
      </Tray>
    </div>
  );
}
