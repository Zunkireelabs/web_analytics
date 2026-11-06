import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Target, X } from 'lucide-react';
import { TrayCard } from '../layout/Tray.jsx';
import { usePosthogState, connectPosthogPath } from '../../lib/posthog-state.jsx';

const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));

// ── What the Behavior tab shows instead of its numbers ────────────────────────────────────────────────────────────
// Not connected: say what it is and offer Connect (to someone who may connect) or tell them who can. Connected but
// nothing in range yet: say so, because the data arrives overnight and an empty chart would look broken.
export function BehaviorEmpty({ siteId, connected, status, canConnect }) {
  return (
    <div className="px-5 py-8 flex gap-4 items-start border-t border-border">
      <span className="w-10 h-10 rounded-[11px] bg-muted grid place-items-center text-text shrink-0"><Activity size={18} /></span>
      <div className="min-w-0">
        {connected && status === 'error' ? (
          <>
            <h3 className="text-[15px] font-semibold text-fg">PostHog needs to be reconnected</h3>
            <p className="mt-1 max-w-[560px] text-[13.5px] leading-5 text-text">PostHog stopped accepting our access, so nothing new is coming in. Reconnecting takes a minute and your earlier numbers are kept.</p>
            <div className="mt-3.5">
              {canConnect ? <Link to={connectPosthogPath(siteId)} className="btn btn--primary btn--sm">Reconnect PostHog</Link> : <span className="text-[13px] text-faint">Ask a project admin to reconnect it.</span>}
            </div>
          </>
        ) : connected ? (
          <>
            <h3 className="text-[15px] font-semibold text-fg">PostHog is connected, and the first numbers are on their way</h3>
            <p className="mt-1 max-w-[560px] text-[13.5px] leading-5 text-text">We read yesterday&rsquo;s activity every night and fill in the last 30 days in the background. Check back tomorrow.</p>
          </>
        ) : (
          <>
            <h3 className="text-[15px] font-semibold text-fg">See what visitors do on your site</h3>
            <p className="mt-1 max-w-[560px] text-[13.5px] leading-5 text-text">
              Connect PostHog to see pages viewed, visits, and the exact pages and steps where people leave or click. If your site already uses PostHog it takes about a minute.
            </p>
            <div className="mt-3.5 flex flex-wrap items-center gap-4">
              {canConnect
                ? <Link to={connectPosthogPath(siteId)} className="btn btn--primary btn--sm">Connect PostHog</Link>
                : <span className="text-[13px] text-faint">Ask a project admin to connect it.</span>}
              {canConnect && <Link to={`${connectPosthogPath(siteId)}&guide=1`} className="text-[13px] font-medium text-primary hover:underline">How to install it</Link>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── "Where visitors stop": the ranked list + one takeaway. `behaviour` is the server's behaviourModel result, the
// same labels, shares and sentence the reports use. ───────────────────────────────────────────────────────────────
export function WhereVisitorsStopCard({ behaviour, rangeLabel }) {
  if (!behaviour || !behaviour.stops?.length) return null;
  const top = Math.max(1, ...behaviour.stops.map((s) => s.n));
  return (
    <TrayCard title="Where visitors stop"
      subtitle={`The last page or action before a visit ended${rangeLabel ? ` · ${rangeLabel}` : ''} · from your own site analytics`}
      action={<Link to="/reports" className="btn btn--light btn--sm">Weekly report →</Link>}>
      <div className="grid lg:grid-cols-[1.7fr_1fr] border-t border-border">
        <ol className="py-1">
          {behaviour.stops.map((s, i) => (
            <li key={s.label} className={`grid items-center gap-3 px-4 py-2.5 grid-cols-[20px_minmax(0,1fr)_56px] sm:grid-cols-[20px_minmax(0,1fr)_minmax(0,130px)_60px_44px] ${i ? 'border-t border-border' : ''}`}>
              <span className="text-[12.5px] text-faint-2 tnum">{i + 1}</span>
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] text-fg" title={s.label}>{s.label}</span>
                {s.raw && <span className="block truncate text-[12px] text-faint font-mono">{s.raw}</span>}
              </span>
              <span className="h-1.5 rounded-full bg-muted hidden sm:block" aria-hidden><span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round((s.n / top) * 100)}%` }} /></span>
              <span className="text-right text-[13.5px] text-fg tnum">{fmt(s.n)}</span>
              <span className="text-right text-[12.5px] text-faint tnum hidden sm:block">{s.share == null ? '' : `${s.share}%`}</span>
            </li>
          ))}
        </ol>
        {behaviour.takeaway && (
          <div className="px-5 py-5 lg:border-l border-t lg:border-t-0 border-border flex flex-col justify-center" style={{ background: '#fcfbfa' }}>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.06em] text-primary"><Target size={12} />Look here first</span>
            <p className="mt-2 text-[13.5px] leading-[21px] text-text">{behaviour.takeaway}</p>
          </div>
        )}
      </div>
      {behaviour.note && <p className="px-4 py-2.5 border-t border-border text-xs text-faint">{behaviour.note}</p>}
    </TrayCard>
  );
}

// ── "What visitors did": the most-used clicks and form steps. `actions` is summary.topActions [{label, raw, times}]. ──
export function WhatVisitorsDidCard({ actions, visits, rangeLabel }) {
  if (!actions?.length) return null;
  const top = Math.max(1, ...actions.map((a) => Number(a.times || 0)));
  return (
    <TrayCard title="What visitors did" subtitle={`Clicks and form steps${rangeLabel ? ` · ${rangeLabel}` : ''} · from your own site analytics`}>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Action</th><th className="num">Times</th><th className="num hidden sm:table-cell">Per 100 visits</th></tr></thead>
          <tbody>
            {actions.map((a) => (
              <tr key={a.raw || a.label}>
                <td className="max-w-0 w-full">
                  <span className="block truncate text-[13.5px]" title={a.raw || a.label}>{a.label}</span>
                  <span className="block h-[3px] rounded-full mt-1.5 max-w-[360px]" style={{ background: '#eef3fb' }}>
                    <i className="block h-full rounded-full" style={{ width: `${Math.max(2, (Number(a.times || 0) / top) * 100)}%`, background: '#9bbcec' }} />
                  </span>
                </td>
                <td className="num">{fmt(a.times)}</td>
                <td className="num hidden sm:table-cell">{visits ? Math.round((Number(a.times || 0) / visits) * 100) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TrayCard>
  );
}

// ── The optional strip at the top of Overview for someone who skipped PostHog. Quiet (white, not the orange setup
// banner) so it can sit beside that banner; dismissible per project and remembered. ───────────────────────────────
const dismissKey = (siteId) => `posthog-strip-dismissed:${siteId}`;
const wasDismissed = (siteId) => { try { return localStorage.getItem(dismissKey(siteId)) === '1'; } catch { return false; } };

export function ConnectPosthogStrip({ siteId }) {
  const { state } = usePosthogState();
  const [gone, setGone] = useState(false);
  const broken = Boolean(state?.connected && state.status === 'error');
  // A broken connection is not "optional": it is told again even after the optional strip was dismissed.
  if (!siteId || !state || (state.connected && !broken) || !state.canConnect || gone || (!broken && wasDismissed(siteId))) return null;
  const dismiss = () => { try { localStorage.setItem(dismissKey(siteId), '1'); } catch { /* storage unavailable */ } setGone(true); };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-card bg-white pl-3.5 pr-2 py-2.5" style={{ boxShadow: '0 0 0 1px var(--border-2)' }}>
      <span className="w-[30px] h-[30px] rounded-[9px] bg-primary-tint text-primary grid place-items-center shrink-0" style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}><Activity size={15} /></span>
      <p className="flex-1 min-w-[220px] text-[13.5px] leading-[19px] text-text">
        {broken
          ? <><b className="font-medium text-fg">PostHog needs to be reconnected.</b> It stopped accepting our access, so the Behavior tab and your reports have no new visitor numbers.</>
          : <><b className="font-medium text-fg">Optional: see where visitors leave your site.</b> Connect PostHog to add it here and to your weekly report.</>}
      </p>
      {!broken && <Link to={`${connectPosthogPath(siteId)}&guide=1`} className="text-[13px] font-medium text-primary hover:underline whitespace-nowrap">How to install</Link>}
      <Link to={connectPosthogPath(siteId)} className="btn btn--primary btn--sm">{broken ? 'Reconnect PostHog' : 'Connect PostHog'}</Link>
      <button type="button" aria-label="Dismiss" onClick={dismiss} className="w-7 h-7 rounded-control grid place-items-center text-faint hover:bg-muted"><X size={14} /></button>
    </div>
  );
}
