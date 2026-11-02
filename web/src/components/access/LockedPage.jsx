import { Lock } from 'lucide-react';
import Button from '../Button.jsx';
import { CONTACT_URL } from '../../lib/access.jsx';
import { visibleGroups } from '../../lib/nav.js';

const ghostWidths = [92, 70, 84, 60, 78, 66];

// What a locked project sees on a page it cannot use yet: the page, faded, behind one card. "Start free trial" goes to
// Contact us, because a person at SuperRank decides who gets in (server/store/access.js).
export default function LockedPage({ access, path, site }) {
  const label = visibleGroups({ isPlatformAdmin: false, isProduct: false }).flatMap((g) => g.items).find((n) => n.to === path)?.label
    || (path === '/workspace' ? 'Workspace' : 'This page');
  const ended = access?.state === 'ended';
  const waiting = access?.state === 'pending';
  const line = ended ? 'Your demo has ended. Talk to us to unlock it again.'
    : waiting ? 'Unlocks once your request is approved. Talk to us if you would like to start sooner.'
    : 'Talk to us to unlock it.';
  return (
    <div className="max-w-[1000px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      {site && path === '/workspace' && (
        <div className="mb-5 rounded-card bg-white p-4 flex items-center gap-3" style={{ boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' }}>
          <span className="w-10 h-10 rounded-control bg-fg text-white grid place-items-center font-semibold shrink-0">{(site.name || '?').charAt(0).toUpperCase()}</span>
          <div className="min-w-0"><div className="text-[15px] font-semibold text-fg truncate">{site.name}</div><div className="text-xs text-faint truncate">{site.website_domain}</div></div>
          <span className="ml-auto text-xs text-faint">Your project</span>
        </div>
      )}
      <div className="relative rounded-card bg-white overflow-hidden min-h-[360px]" style={{ boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' }}>
        <div aria-hidden="true" className="p-6 select-none pointer-events-none" style={{ filter: 'blur(2.5px)', opacity: 0.75 }}>
          <div className="h-5 w-48 rounded bg-[#e4e1da] mb-6" />
          {ghostWidths.map((w, i) => <div key={i} className="h-3 rounded bg-[#e4e1da] mb-4" style={{ width: `${w}%` }} />)}
          <div className="grid grid-cols-3 gap-3 mt-6">{[0, 1, 2].map((i) => <div key={i} className="h-24 rounded-card bg-muted" />)}</div>
        </div>
        <div className="absolute inset-0 grid place-items-center p-4">
          <div className="max-w-[320px] rounded-card bg-white/95 px-6 py-5 text-center" style={{ boxShadow: '0 0 0 1px var(--border-2), 0 12px 30px -12px rgba(40,30,20,.25)' }}>
            <span className="mx-auto w-9 h-9 rounded-control bg-white grid place-items-center" style={{ boxShadow: '0 0 0 1px var(--border-2)' }}><Lock size={16} /></span>
            <div className="mt-2 text-[15px] font-semibold text-fg">{label} is part of your free trial</div>
            <p className="mt-1 text-[13px] leading-[18px] text-text">{line}</p>
            <a href={CONTACT_URL} target="_blank" rel="noreferrer" className="inline-block mt-3">
              <Button variant="primary">Start free trial</Button>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
