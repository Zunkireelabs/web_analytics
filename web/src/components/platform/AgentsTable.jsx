import { useMemo, useState } from 'react';
import Badge from '../Badge.jsx';

// Every agent that runs for one client: what it does, when it last ran, how it went and how long it took. Read only. `agents` is
// the detail payload's list: [{ id, name, description, lastRunAt, lastStatus: 'ok'|'failed'|'skipped', tookMs, runs7d }].
const RESULT = { ok: ['green', 'Ran'], failed: ['red', 'Failed'], skipped: ['grey', 'Skipped'] };
const isToday = (d) => new Date(d).toDateString() === new Date().toDateString();
const isYesterday = (d) => new Date(d).toDateString() === new Date(Date.now() - 864e5).toDateString();
const clock = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const when = (d) => (!d ? 'Never' : isToday(d) ? `Today ${clock(d)}` : isYesterday(d) ? `Yesterday ${clock(d)}` : `${new Date(d).toLocaleDateString('en-GB', { weekday: 'short' })} ${clock(d)}`);
const took = (ms) => (ms == null ? '—' : ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${Math.max(1, Math.round(ms / 1000))} s`);

export default function AgentsTable({ agents = [], waitingText }) {
  const [filter, setFilter] = useState('all');
  const counts = useMemo(() => ({ all: agents.length, ok: agents.filter((a) => a.lastStatus === 'ok').length, failed: agents.filter((a) => a.lastStatus === 'failed').length, skipped: agents.filter((a) => a.lastStatus === 'skipped').length }), [agents]);
  const rows = filter === 'all' ? agents : agents.filter((a) => a.lastStatus === filter);
  if (!agents.length) return <p className="px-4 pb-4 text-[13.5px] text-faint">{waitingText || 'No agent has run for this project yet.'}</p>;
  const chips = [['all', `All ${counts.all}`], ['ok', `Ran ${counts.ok}`], ['failed', `Failed ${counts.failed}`], ['skipped', `Skipped ${counts.skipped}`]].filter(([k]) => k === 'all' || counts[k] > 0 || filter === k);
  return (
    <div>
      <div className="flex flex-wrap gap-2 px-4 pb-3" role="group" aria-label="Filter agents">
        {chips.map(([k, label]) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}
            className={`px-3 py-1 rounded-full text-[12.5px] ${filter === k ? 'bg-primary-tint text-[#7a3400]' : 'bg-white text-text'}`} style={{ boxShadow: filter === k ? 'inset 0 0 0 1px var(--primary-ring)' : '0 0 0 1px var(--input)' }}>{label}</button>
        ))}
      </div>
      <div className="hidden md:grid grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_110px_90px_90px] gap-3 px-4 py-2 text-xs text-faint bg-[#fafaf9] border-y border-border">
        <span>Agent</span><span>Last run</span><span>Result</span><span className="text-right">Took</span><span className="text-right">Runs, 7 days</span>
      </div>
      <ul className="list-none m-0 p-0 divide-y divide-border">
        {rows.map((a) => {
          const [tone, text] = RESULT[a.lastStatus] || RESULT.failed;
          return (
            <li key={a.id} className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_110px_90px_90px] items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13.5px]">
              <span className="min-w-0"><b className="block font-medium text-fg">{a.name}</b>{a.description && <span className="block text-xs leading-[17px] text-faint" title={a.description} style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.description}</span>}</span>
              <span className="md:order-none order-3 col-span-2 md:col-span-1 text-text">{when(a.lastRunAt)}</span>
              <span><Badge tone={tone} dot>{text}</Badge></span>
              <span className="hidden md:block text-right tnum text-text">{took(a.tookMs)}</span>
              <span className="hidden md:block text-right tnum text-text">{a.runs7d}</span>
              <span className="md:hidden col-span-2 text-xs text-faint">{took(a.tookMs)} · {a.runs7d} runs in 7 days</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
