import { useState } from 'react';
import { Building2, ChevronDown, Info } from 'lucide-react';
import Button from '../Button.jsx';
import { initials, StatusPill } from './RequestsParts.jsx';
import { ago, plural, visibleProjects } from '../../lib/requests-view.js';

const fmtLong = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

// One card per person who asked to come back: tinted header (account dates, asked), the removed workspace and its projects (4 shown, rest on
// "Show all"), and the Approve / Reject buttons while it is waiting.
function HoldCard({ x, busy, onApprove, onReject }) {
  const [open, setOpen] = useState({});
  const pending = x.status === 'pending';
  const dates = [x.accountCreatedAt && `Account made ${fmtLong(x.accountCreatedAt)}`, (x.lastSignedInAt || x.lastLoginAt) && `last signed in ${fmtLong(x.lastSignedInAt || x.lastLoginAt)}`].filter(Boolean).join(' · ');
  return (
    <div className="rounded-card bg-white overflow-hidden" style={{ boxShadow: '0 0 0 1px var(--input)' }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 px-3.5 py-3" style={{ background: '#fafaf9', borderBottom: '1px solid var(--border)' }}>
        <span className="size-[30px] rounded-[9px] bg-fg text-white grid place-items-center text-xs font-semibold shrink-0">{(x.name || x.email || '?')[0].toUpperCase()}</span>
        <div className="min-w-0 flex-[1_1_240px]">
          <p className="text-sm font-semibold text-fg truncate">{x.name ? `${x.name} · ` : ''}{x.email}</p>
          {dates && <p className="text-[12.5px] text-faint">{dates}</p>}
        </div>
        <span className="text-[12.5px] text-faint sm:ml-auto sm:text-right">Asked {ago(x.requestedAt)}</span>
        {pending ? (
          <div className="flex gap-2 max-sm:w-full">
            <Button variant="primary" size="sm" className="max-sm:flex-1" disabled={busy} onClick={onApprove}>Approve and send code</Button>
            <Button variant="light" size="sm" disabled={busy} onClick={onReject}>Reject</Button>
          </div>
        ) : <StatusPill tone={x.status === 'approved' ? 'client' : 'rejected'}>{x.status === 'approved' ? 'Approved, code sent' : 'Not approved'}</StatusPill>}
      </div>
      {x.removed?.length > 0 ? x.removed.map((w) => {
        const k = `${w.workspace}-${w.deletedAt}`;
        const projects = w.projects || [];
        const ex = Boolean(open[k]);
        return (
          <div key={k}>
            <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-text" style={{ borderBottom: projects.length ? '1px solid var(--border)' : undefined }}>
              <span className="size-[22px] rounded-[7px] bg-fg text-white grid place-items-center shrink-0"><Building2 size={12} /></span>
              <b className="font-medium text-fg">{w.workspace}</b>
              <span className="text-faint">workspace removed {fmtLong(w.deletedAt)}</span>
              <span className="px-2 py-0.5 rounded-full text-xs" style={{ background: '#fdf3e1', color: '#8a5300' }}>{plural(projects.length, 'project')}</span>
              {projects.length > 4 && (
                <button type="button" aria-expanded={ex} onClick={() => setOpen((o) => ({ ...o, [k]: !ex }))}
                  className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-control text-[13px] font-medium text-primary hover:bg-primary-tint">
                  {ex ? 'Show fewer' : `Show all ${projects.length}`}<ChevronDown size={13} className={ex ? 'rotate-180' : ''} />
                </button>
              )}
            </div>
            <ul className="list-none m-0 p-0">
              {visibleProjects(projects, ex).map((p) => (
                <li key={p} className="flex items-center gap-3 px-3.5 py-2.5 border-b border-border last:border-0">
                  <span className="size-[30px] rounded-[9px] bg-primary text-white grid place-items-center text-[10px] font-semibold shrink-0">{initials(p)}</span>
                  <b className="text-[13.5px] font-medium text-fg min-w-0 truncate">{p}</b>
                  <span className="ml-auto px-2 py-0.5 rounded-full text-xs whitespace-nowrap" style={{ background: '#fdecec', color: '#b42318' }}>Removed</span>
                </li>
              ))}
            </ul>
          </div>
        );
      }) : (
        <p className="px-3.5 py-3 text-[13px] text-text">
          We have no record of which workspace was removed.{x.lastProject ? <> Their account was last pointed at the project <b className="font-medium text-fg">{x.lastProject}</b>.</> : x.reason ? ` ${x.reason}` : ''}
        </p>
      )}
      {pending && <p className="flex items-center gap-1.5 px-3.5 py-2.5 border-t border-border text-[12.5px] text-faint"><Info size={13} />No sign-in code has been sent. Approving emails them a new one.</p>}
    </div>
  );
}

export default function OnHoldList({ rows, busyId, onApprove, onReject }) {
  return (
    <div className="grid gap-3 px-4 sm:px-5 pb-4">
      {rows.map((x) => <HoldCard key={x.id} x={x} busy={busyId === `r${x.id}`} onApprove={() => onApprove(x)} onReject={() => onReject(x)} />)}
    </div>
  );
}
