import { Send, Link2, BellOff, Bell } from 'lucide-react';
import Button from '../Button.jsx';
import Drawer from '../Drawer.jsx';
import { STEP_COUNT, actions, initial, stepList, summaryLine } from '../../lib/signup-progress-view.js';

const DOT = {
  done: 'bg-[#e8f7ee] text-green',
  now: 'bg-primary-tint text-primary',
  todo: 'bg-white text-faint-2',
};
const RING = {
  now: '0 0 0 3px var(--primary-tint), inset 0 0 0 1px var(--primary-ring)',
  todo: 'inset 0 0 0 1px var(--input)',
};

// "Code to Prompts (9 steps)" instead of nine rows that all say the same thing.
const notReached = (todo) => (todo.length <= 2 ? todo.map((s) => s.label).join(' and ') : `${todo[0].label} to ${todo[todo.length - 1].label} (${todo.length} steps)`);

// Side panel for one person on the Get-started sign-ups card: every answer step by step, and the three actions.
export default function SignupProgressDrawer({ row, linkDays, busy, note, onClose, onRemind, onCopy, onMute }) {
  const { canAct, muted } = row ? actions(row) : {};
  const steps = row ? stepList(row) : [];
  const reachedSteps = steps.filter((s) => s.state !== 'todo');
  const todo = steps.filter((s) => s.state === 'todo');
  return (
    <Drawer isOpen={!!row} onClose={onClose} maxWidth="max-w-[440px]" title={row?.email} subtitle={row?.brand ? `${row.brand} · ${row.website}` : 'No website yet'}>
      {row && (
        <div className="-m-6 p-5 flex flex-col min-h-full gap-5">
          {note && (
            <div className={`rounded-control px-3 py-2 text-[13px] break-words ${note.bad ? 'bg-[#fdecec] text-[#b42318]' : 'bg-green-tint text-green'}`} role="status">{note.text}</div>
          )}
          <p className="text-[13px] leading-5 text-text">{summaryLine(row, linkDays)}</p>
          <div className="rounded-card px-4 py-3" style={{ boxShadow: 'inset 0 0 0 1px var(--border-2)', background: '#fcfcfb' }}>
            <div className="flex items-baseline justify-between text-[13px]">
              <span className="font-medium text-fg">Step {row.step} of {STEP_COUNT}</span>
              <span className="text-faint">{Math.round((row.step / STEP_COUNT) * 100)}%</span>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-[#ece9e4] overflow-hidden"><i className="block h-full rounded-full bg-primary" style={{ width: `${(row.step / STEP_COUNT) * 100}%` }} /></div>
          </div>
          <ol className="list-none m-0 p-0" aria-label="Step by step">
            {reachedSteps.map((s, i) => {
              const last = i === reachedSteps.length - 1 && todo.length === 0;
              const now = s.state === 'now';
              return (
                <li key={s.n} className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-3">
                  {!last && <span className="absolute left-[13px] top-7 bottom-0 w-px bg-border-2" aria-hidden="true" />}
                  <i className={`size-7 rounded-full grid place-items-center not-italic text-[12px] font-bold ${DOT[s.state]}`} style={RING[s.state] ? { boxShadow: RING[s.state] } : undefined}>
                    {s.state === 'done' ? '✓' : s.n}
                  </i>
                  <div className={`min-w-0 pb-4 ${now ? '' : 'pt-0.5'}`}>
                    <p className="text-[13.5px] leading-6 font-medium text-fg">{s.label.replace(/\s*·\s*stopped here$/i, '')}{now && <span className="ml-2 text-[11px] font-semibold uppercase tracking-[.06em] text-primary">Stopped here</span>}</p>
                    {(s.chips.length > 0 || s.text) && (
                      <p className="mt-0.5 text-[13px] leading-5 text-text [overflow-wrap:anywhere]">
                        {s.chips.map((c) => (
                          <span key={c.text} className={`inline-block mr-1 mb-1 px-2 py-px rounded-full text-[12px] ${c.draft ? 'bg-white text-primary' : 'bg-muted text-fg'}`}
                            style={c.draft ? { boxShadow: 'inset 0 0 0 1px var(--primary-ring)' } : undefined}>{c.text}</span>
                        ))}
                        {s.chips.length > 0 && s.text && <br />}
                        {s.text}
                      </p>
                    )}
                    {now && s.chips.length === 0 && !s.text && <p className="mt-0.5 text-[13px] text-faint">Nothing entered here yet.</p>}
                  </div>
                </li>
              );
            })}
            {todo.length > 0 && (
              <li className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-3">
                <i className="size-7 rounded-full bg-white" style={{ boxShadow: 'inset 0 0 0 1.5px var(--input)', borderStyle: 'dashed' }} aria-hidden="true" />
                <div className="min-w-0 pt-0.5">
                  <p className="text-[13.5px] leading-6 font-medium text-faint">Not reached yet</p>
                  <p className="text-[12.5px] leading-5 text-faint-2">{notReached(todo)}</p>
                </div>
              </li>
            )}
          </ol>
          <div className="mt-auto sticky bottom-0 -mx-5 -mb-5 px-5 py-3 bg-white flex flex-wrap gap-2 border-t border-border">
            <Button variant="primary" size="sm" write disabled={!canAct || !!busy} onClick={() => onRemind(row)}><Send size={13} />{busy === 'remind' ? 'Sending…' : 'Send reminder'}</Button>
            <Button size="sm" write disabled={!canAct || !!busy} onClick={() => onCopy(row)}><Link2 size={13} />Copy link</Button>
            <Button size="sm" write disabled={!canAct || !!busy} onClick={() => onMute(row, !muted)}>
              {muted ? <Bell size={13} /> : <BellOff size={13} />}{muted ? 'Resume reminders' : 'Stop reminders'}
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}
