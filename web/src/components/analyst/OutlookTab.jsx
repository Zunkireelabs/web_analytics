import StoryCard from './StoryCard.jsx';
import ForecastCard from './ForecastCard.jsx';
import KeywordsCard from './KeywordsCard.jsx';
import LastWeekCard from './LastWeekCard.jsx';
import ShiftsCard from './ShiftsCard.jsx';
import LearningCard from './LearningCard.jsx';

export default function OutlookTab({ outlook, loading, error, onRetry, onSeeFixes, isPlatformAdmin }) {
  if (error) return <Notice text={error} action={<button type="button" className="underline" onClick={onRetry}>Retry</button>} />;
  if (!loading && outlook?.status === 'not-ready') {
    return <Notice text={outlook.message || 'The Analyst is still gathering data for this project. Check back after the next nightly run.'} />;
  }
  const l = loading;
  return (
    <div className="space-y-3">
      {!l && <StoryCard outlook={outlook} onSeeFixes={onSeeFixes} />}
      <div className="grid gap-3 lg:grid-cols-2 items-start">
        <ForecastCard forecast={outlook?.forecast} loading={l} />
        <KeywordsCard keywords={outlook?.keywords} loading={l} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2 items-start">
        <LastWeekCard rows={outlook?.lastWeek} loading={l} />
        <ShiftsCard shifts={outlook?.shifts} loading={l} />
      </div>
      {isPlatformAdmin && <LearningCard />}
    </div>
  );
}

export function Notice({ text, action }) {
  return (
    <div className="tray"><div className="tray-card px-4 py-8 text-sm text-text text-center">{text}{action && <span className="ml-2 text-faint">{action}</span>}</div></div>
  );
}
