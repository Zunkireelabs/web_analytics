import { Lock } from 'lucide-react';
import Button from '../Button.jsx';
import { CONTACT_URL } from '../../lib/access.jsx';

// A card the project cannot use yet: its shape, faded, behind a small lock card. "Start free trial" goes to Contact us.
export default function LockedCard({ title, text, cta = false, rows = 3 }) {
  const widths = [90, 64, 78, 56, 84];
  return (
    <div className="relative rounded-card bg-white overflow-hidden min-h-[170px]" style={{ boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' }}>
      <div aria-hidden="true" className="p-5 select-none pointer-events-none" style={{ filter: 'blur(2.5px)', opacity: 0.75 }}>
        <div className="h-4 w-36 rounded bg-[#e4e1da] mb-4" />
        {widths.slice(0, rows).map((w, i) => <div key={i} className="h-2.5 rounded bg-[#e4e1da] mb-3" style={{ width: `${w}%` }} />)}
      </div>
      <div className="absolute inset-0 grid place-items-center p-3">
        <div className="max-w-[260px] rounded-card bg-white/95 px-5 py-4 text-center" style={{ boxShadow: '0 0 0 1px var(--border-2), 0 12px 30px -12px rgba(40,30,20,.25)' }}>
          <span className="mx-auto w-8 h-8 rounded-control bg-white grid place-items-center" style={{ boxShadow: '0 0 0 1px var(--border-2)' }}><Lock size={14} /></span>
          <div className="mt-1.5 text-sm font-semibold text-fg">{title}</div>
          <p className="mt-0.5 text-xs leading-4 text-text">{text}</p>
          {cta && <a href={CONTACT_URL} target="_blank" rel="noreferrer" className="inline-block mt-2.5"><Button variant="primary">Start free trial</Button></a>}
        </div>
      </div>
    </div>
  );
}
