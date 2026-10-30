import Badge from '../Badge.jsx';
import Card, { ROW } from './Card.jsx';

const BADGE = {
  fixed: <Badge tone="green">Fixed automatically</Badge>,
  fixing: <Badge tone="amber">Agent fixing · 07:00</Badge>,
  'needs-ok': <Badge tone="red">Waiting for your OK</Badge>,
};

export default function WeekCard({ week, loading }) {
  const has = week && week.length > 0;
  return (
    <Card title="What the agent does this week" loading={loading} empty={!loading && !has ? 'Nothing planned yet.' : null} maxHeight={300}>
      {has && week.map((w, i) => (
        <div key={`${w.when}-${i}`} className={`${ROW} items-center`}>
          <span className="text-xs text-faint w-24 shrink-0">{w.when}</span>
          <span className="min-w-0 flex-1 text-fg">{w.title}</span>
          <span className="shrink-0">{BADGE[w.stage]}</span>
        </div>
      ))}
    </Card>
  );
}
