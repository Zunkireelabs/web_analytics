import Badge from './Badge.jsx';

// Impact reads as a status (high impact is good); effort is only context, so
// low effort stays calm (grey) rather than green.
const IMPACT_TONE = { High: 'green', Medium: 'amber', Low: 'grey' };
const EFFORT_TONE = { Low: 'grey', Medium: 'amber', High: 'red' };

// One hairline-separated row; the parent supplies the surrounding .card.
export default function RecommendationCard({ title, reason, impact, effort }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-x-4 px-4 py-3.5 border-b border-border last:border-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-fg">{title}</div>
        <div className="text-[13px] text-text mt-0.5">{reason}</div>
      </div>
      <div className="mt-2 sm:mt-0 flex flex-row sm:flex-col items-start sm:items-end gap-1 sm:row-span-2 sm:col-start-2 sm:row-start-1">
        <Badge tone={IMPACT_TONE[impact] || 'grey'}>Impact: {impact}</Badge>
        <Badge tone={EFFORT_TONE[effort] || 'grey'}>Effort: {effort}</Badge>
      </div>
    </div>
  );
}
