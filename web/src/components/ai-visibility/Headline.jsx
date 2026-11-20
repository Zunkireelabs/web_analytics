import { Link } from 'react-router-dom';
import Badge from '../Badge.jsx';
import { engineLabel } from './engines.js';
import { timeAgo } from '../../api.js';

// The top of AI visibility: one plain answer ("AI recommends you in 12 of 30 questions") and how each AI engine did.
// Pressing an engine's bar shows only that engine in the lists below; pressing it again shows all.
export default function Headline({ summary, trend, lastChecked, engines, active, onPick, loading }) {
  return (
    <div className="grid gap-3 lg:grid-cols-[1.1fr_1fr] mb-3">
      <div className="rounded-card bg-white p-6" style={{ boxShadow: 'var(--card-shadow)' }}>
        <div className="text-[11px] font-medium tracking-[.08em] uppercase text-faint">AI recommends you in</div>
        {loading ? <div className="h-14 mt-3 rounded-control bg-muted animate-pulse" /> : summary.total === 0 ? (
          <p className="mt-3 text-[15px] text-text">Nothing has been checked yet. Once the agent asks AI engines your buyers' questions, the answer shows here.</p>
        ) : (
          <>
            <div className="mt-2.5 text-[56px] leading-none font-semibold tracking-[-0.04em] tnum text-fg">{summary.n}<span className="text-[22px] font-medium tracking-[-0.01em] text-faint"> of {summary.total} questions</span></div>
            <div className="mt-3.5 h-2 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-primary" style={{ width: `${summary.pct}%` }} /></div>
            <div className="mt-3 flex flex-wrap items-center gap-2.5 text-[13px]">
              {trend && trend.dir !== 'same' && <Badge tone={trend.dir === 'up' ? 'green' : 'amber'}>{trend.dir === 'up' ? '▲' : '▼'} {trend.points} {trend.points === 1 ? 'point' : 'points'} {trend.dir === 'up' ? 'up' : 'down'} since the last check</Badge>}
              {lastChecked && <span className="text-faint">Checked {timeAgo(lastChecked)}</span>}
            </div>
          </>
        )}
      </div>
      <div className="rounded-card bg-white p-6" style={{ boxShadow: 'var(--card-shadow)' }}>
        <div className="text-[11px] font-medium tracking-[.08em] uppercase text-faint mb-3">By AI engine</div>
        <div className="grid gap-2.5">
          {engines.map((e) => (
            <div key={e.id} className="flex items-center gap-3 text-sm">
              {e.configured ? (
                <button type="button" onClick={() => onPick(active === e.id ? 'all' : e.id)} aria-pressed={active === e.id} className={`flex items-center gap-3 flex-1 min-w-0 text-left rounded-control px-1.5 py-0.5 ${active === e.id ? 'bg-primary-tint' : 'hover:bg-muted'}`}>
                  <span className="w-[96px] shrink-0 text-fg">{engineLabel(e.id)}</span>
                  <span className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden"><span className="block h-full rounded-full bg-primary" style={{ width: `${e.pct}%` }} /></span>
                  <b className="font-semibold tnum w-[64px] text-right text-fg">{e.total ? `${e.n} / ${e.total}` : '—'}</b>
                </button>
              ) : (
                <div className="flex items-center gap-3 flex-1 min-w-0 px-1.5 py-0.5">
                  <span className="w-[96px] shrink-0 text-faint">{engineLabel(e.id)}</span>
                  <Badge tone="grey">Not connected</Badge>
                  <Link to="/account?tab=connections" className="ml-auto text-[13px] font-medium text-primary-strong">Connect</Link>
                </div>
              )}
            </div>
          ))}
          {!engines.length && !loading && <p className="text-[13px] text-text">No AI engines are set up yet.</p>}
        </div>
      </div>
    </div>
  );
}
