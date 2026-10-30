import { Check } from 'lucide-react';
import Card, { ROW } from './Card.jsx';
import { STATUS } from '../../lib/palette.js';
import { whenLabel } from '../../lib/analyst-view.js';

export default function SolvedCard({ solved, loading }) {
  const has = solved && solved.length > 0;
  return (
    <Card
      title="Solved so far" subtitle="After each fix the system checks what really happened, so you can see it worked"
      loading={loading} empty={!loading && !has ? 'Nothing here yet. Results show up after a fix has had time to work.' : null}
      maxHeight={320} footer={has && <><span>Results are measured after each fix</span><span /></>}
    >
      {has && solved.map((s) => (
        <div key={s.id} className={ROW}>
          <span className="w-5 h-5 rounded-full grid place-items-center shrink-0 mt-px" style={{ background: STATUS.good.tint, color: STATUS.good.text }}><Check size={12} strokeWidth={2.5} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-fg">{s.title}</div>
            <div className="text-xs text-faint mt-0.5">{[whenLabel(s.when), s.detail].filter(Boolean).join(' · ')}</div>
          </div>
          {s.gain && <span className="tnum text-[13px] text-right shrink-0 max-w-[40%]" style={{ color: STATUS.good.text }}>{s.gain}</span>}
        </div>
      ))}
    </Card>
  );
}
