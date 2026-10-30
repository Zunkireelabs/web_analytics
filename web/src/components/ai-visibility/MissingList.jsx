import { Check, Zap } from 'lucide-react';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import ListCard, { ROW } from './ListCard.jsx';

const STATE = {
  queued: <Badge tone="amber">Agent working · 07:00</Badge>,
  drafted: <Badge tone="primary">Draft ready</Badge>,
};

export default function MissingList({ rows, picked, onToggle, onSelectAll, onShip, busy, loading, message }) {
  const open = rows.filter((p) => !p.ship);
  const n = picked.size;
  return (
    <ListCard
      title={`Where you are missing${loading ? '' : ` · ${rows.length}`}`}
      subtitle="Tick the ones to fix. Ship now, or leave them for the 07:00 run"
      action={open.length > 0 && (
        <button type="button" className="text-xs text-primary hover:underline" onClick={onSelectAll}>
          {n === open.length ? 'Clear' : 'Select all'}
        </button>
      )}
      empty={loading ? 'Loading…' : !rows.length ? 'No missed prompts. Every checked prompt names you.' : null}
      footer={!loading && (
        <>
          <span className="min-w-0 truncate">{message || `${n} selected`}</span>
          <span className="flex items-center gap-1.5 shrink-0">
            <Button size="sm" variant="light" disabled={!n || busy} onClick={() => onShip(false)}>Leave for 07:00</Button>
            <Button size="sm" variant="primary" disabled={!n || busy} onClick={() => onShip(true)}><Zap size={13} />Ship {n || ''} now</Button>
          </span>
        </>
      )}
    >
      {rows.map((p) => {
        const on = picked.has(p.id);
        return (
          <label key={p.id} className={`${ROW} ${p.ship ? '' : 'cursor-pointer hover:bg-black/[.015]'}`}>
            <input type="checkbox" className="sr-only" checked={on} disabled={!!p.ship || busy} onChange={() => onToggle(p.id)} />
            <span
              aria-hidden
              className={`mt-0.5 w-4 h-4 rounded-[5px] grid place-items-center shrink-0 ${on ? 'bg-primary text-white' : 'bg-white'} ${p.ship ? 'opacity-40' : ''}`}
              style={on ? undefined : { boxShadow: 'inset 0 0 0 1.5px var(--input)' }}
            >
              {on && <Check size={11} strokeWidth={3} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-fg">“{p.promptText}”</div>
              <div className="text-xs text-faint mt-0.5">
                Not seen in {p.checks} check{p.checks === 1 ? '' : 's'}
                {p.competitors.length > 0 && ` · shown instead: ${p.competitors.slice(0, 3).join(', ')}`}
              </div>
              {p.shipError && <div className="text-xs mt-0.5" style={{ color: 'var(--critical, #b42318)' }}>Last try failed: {p.shipError}</div>}
            </div>
            {p.ship && <span className="shrink-0">{STATE[p.ship]}</span>}
          </label>
        );
      })}
    </ListCard>
  );
}
