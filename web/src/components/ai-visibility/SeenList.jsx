import { STATUS } from '../../lib/palette.js';
import Badge from '../Badge.jsx';
import ListCard, { ROW } from './ListCard.jsx';
import { engineLabel } from './engines.js';

export default function SeenList({ rows, total, loading }) {
  return (
    <ListCard
      title={`Where you are seen${loading ? '' : ` · ${rows.length}`}`}
      subtitle="Rank in the answer, and how often across checks"
      empty={loading ? 'Loading…' : !rows.length ? 'No prompt names you yet. Once the agent has checked your prompts, the ones that do will show here.' : null}
      footer={!loading && <><span>{rows.length} of {total} checked prompts</span><span /></>}
    >
      {rows.map((p) => (
        <div key={p.id} className={ROW}>
          <div className="min-w-0 flex-1">
            <div className="text-fg">“{p.promptText}”</div>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-1.5 w-24 rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${(p.hits / p.checks) * 100}%`, background: STATUS.good.color }} />
              </div>
              <span className="text-xs text-faint tnum">seen in {p.hits} of {p.checks} check{p.checks === 1 ? '' : 's'}</span>
            </div>
          </div>
          <div className="text-right shrink-0">
            <Badge tone="green">{p.position != null ? `Rank #${p.position}` : 'Mentioned'}</Badge>
            <div className="text-xs text-faint mt-1">{p.seenOn.map(engineLabel).join(', ')}</div>
          </div>
        </div>
      ))}
    </ListCard>
  );
}
