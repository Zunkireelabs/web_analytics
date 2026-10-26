import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PageIntro from '../components/layout/PageIntro.jsx';
import { Tray } from '../components/layout/Tray.jsx';
import GrowthScores from '../components/GrowthScores.jsx';
import AiRecommendationCard from '../components/AiRecommendationCard.jsx';

// AI visibility: how often AI engines mention and recommend this brand. The AI-search card used to sit
// at the bottom of the Orchestration page (now Agents); it leads its own page now, under the score row
// that includes GEO. Same real, already-persisted agent output as before.
export default function AiVisibility() {
  const [ccData, setCcData] = useState(null); // null = loading

  useEffect(() => {
    let cancelled = false;
    api.commandCenter.get().then((d) => { if (!cancelled) setCcData(d); }).catch(() => { if (!cancelled) setCcData({}); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageIntro title="AI visibility" subtitle="How often ChatGPT and other AI engines recommend you when buyers ask" />

      <GrowthScores data={ccData} loading={ccData === null} />

      <Tray className="mt-3" title="AI search visibility" source="ChatGPT buyer-intent prompts">
        <AiRecommendationCard aiRecommendation={ccData?.aiRecommendation} meta={ccData?.aiRecommendationMeta} loading={ccData === null} />
      </Tray>
    </div>
  );
}
