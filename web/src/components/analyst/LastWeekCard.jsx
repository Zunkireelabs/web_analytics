import Card, { ROW } from './Card.jsx';
import { STATUS } from '../../lib/palette.js';

const num = (v) => (typeof v === 'number' ? Math.round(v).toLocaleString('en-US') : v);

export default function LastWeekCard({ rows, loading }) {
  const has = rows && rows.length > 0;
  return (
    <Card
      title="Last week: predicted vs what happened" subtitle="How much to trust the numbers above"
      loading={loading} empty={!loading && !has ? 'Nothing here yet. This fills in after the first predicted week has passed.' : null}
      maxHeight={260}
    >
      {has && rows.map((r) => (
        <div key={r.label} className={`${ROW} items-center`}>
          <span className="min-w-0 flex-1 text-fg">{r.label}</span>
          <span className="text-xs text-faint tnum hidden sm:block">predicted {num(r.predicted)}</span>
          <span className="tnum text-fg text-right w-20 shrink-0">{num(r.actual)}</span>
          <span className="text-xs text-right w-16 shrink-0" style={{ color: STATUS.good.text }}>
            {typeof r.errorPct === 'number' ? `${Math.round(r.errorPct)}% off` : (r.note || '')}
          </span>
        </div>
      ))}
    </Card>
  );
}
