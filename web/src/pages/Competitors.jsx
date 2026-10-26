import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageIntro from '../components/layout/PageIntro.jsx';
import { Tray } from '../components/layout/Tray.jsx';
import Section from '../components/layout/Section.jsx';
import CompetitorLeaderboard from '../components/CompetitorLeaderboard.jsx';
import AuthorityScoreCard from '../components/AuthorityScoreCard.jsx';
import ReferringDomainsCard from '../components/ReferringDomainsCard.jsx';
import CompetitorBacklinkCard from '../components/CompetitorBacklinkCard.jsx';
import CompetitorRankingCard from '../components/CompetitorRankingCard.jsx';

// Competitors: who this site is up against, and how it compares. These sections used to share the
// Orchestration page (now Agents) with the agent run console; they have their own page now. The data is
// the same real, already-persisted agent output the score row on the Agents page reads.
export default function Competitors() {
  const [ccData, setCcData] = useState(null); // null = loading
  const [backlinks, setBacklinks] = useState(null); // null = loading

  useEffect(() => {
    let cancelled = false;
    api.commandCenter.get().then((d) => { if (!cancelled) setCcData(d); }).catch(() => { if (!cancelled) setCcData({}); });
    // The referring-domain summary for this project's OWN domain (the server takes it from the session).
    api.commonCrawlBacklinks.summaryOwn().then((d) => { if (!cancelled) setBacklinks(d); })
      .catch(() => { if (!cancelled) setBacklinks({ status: 'insufficient-data', message: 'Could not load referring domain data right now.' }); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageIntro title="Competitors" subtitle="Who you are up against, and how you compare online" />

      <Section tray title="Competitors" subtitle="How you compare online · click a competitor to see why">
        {ccData?.competitors && ccData.competitors.length > 0 ? (
          <CompetitorLeaderboard profiles={ccData.competitors} />
        ) : (
          <div className="text-sm text-faint text-center py-10 border-t border-border">
            {ccData === null ? 'Loading competitors…' : 'No competitors logged yet.'}
          </div>
        )}
      </Section>

      <Tray className="mt-3 md:grid-cols-2" title="Backlinks and rankings" subtitle="How your authority and rankings stack up" source="Backlinks & rankings">
        <AuthorityScoreCard authority={ccData?.authority} meta={ccData?.authorityMeta} loading={ccData === null} />
        <ReferringDomainsCard summary={backlinks} loading={backlinks === null} />
        <CompetitorBacklinkCard backlinkComparison={ccData?.backlinkComparison} meta={ccData?.backlinkComparisonMeta} loading={ccData === null} />
        <CompetitorRankingCard rankingComparison={ccData?.rankingComparison} meta={ccData?.rankingComparisonMeta} loading={ccData === null} />
      </Tray>
    </div>
  );
}
