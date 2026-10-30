import { TrendingDown, TrendingUp, Activity } from 'lucide-react';
import Card, { ROW } from './Card.jsx';
import { STATUS } from '../../lib/palette.js';

const ICON = { up: TrendingUp, down: TrendingDown, flat: Activity };

export default function ShiftsCard({ shifts, loading }) {
  const has = shifts && shifts.length > 0;
  return (
    <Card
      title="What is shifting in your field" subtitle="From outside trends, from projects like yours, and from what people search for on your site"
      loading={loading} empty={!loading && !has ? 'Nothing here yet. Shifts show up when the trend agent, projects like yours, or your own searches pick one up.' : null}
      maxHeight={300}
    >
      {has && shifts.map((s) => {
        const Icon = ICON[s.direction] || Activity;
        const color = s.direction === 'up' ? STATUS.good : s.direction === 'down' ? STATUS.critical : STATUS.neutral;
        return (
          <div key={s.text} className={`${ROW} items-center`}>
            <span className="w-5 h-5 rounded-full grid place-items-center shrink-0" style={{ background: color.tint, color: color.text }}><Icon size={12} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-fg">{s.text}</div>
              {s.source && <div className="text-xs text-faint">{s.source}</div>}
            </div>
          </div>
        );
      })}
    </Card>
  );
}
