import { Link } from 'react-router-dom';
import Badge from '../Badge.jsx';
import { CONTENT_TYPES } from '../../lib/content-types.js';

const STEPS = [
  { id: 'ideas', label: 'Ideas', sub: 'pick what the agent writes' },
  { id: 'review', label: 'Drafted', sub: 'read and approve' },
  { id: 'history', label: 'History', sub: 'what went live' },
];
const to = (view, type) => {
  const q = new URLSearchParams();
  if (view !== 'ideas') q.set('view', view);
  if (type !== 'all') q.set('type', type);
  const s = q.toString();
  return `/content${s ? `?${s}` : ''}`;
};

// The top of the Content page, the same on all three steps: the kind toggle (All, Landing pages, Translations, Blog posts) that
// filters everything below it, then the stage strip Ideas -> Drafted -> History with the numbers for the chosen kind.
// `counts` is { [typeKey]: { ideas, drafted, waiting, history } }.
export default function ContentStages({ view, type, counts }) {
  const n = (key) => counts[key] || { ideas: 0, drafted: 0, waiting: 0, history: 0 };
  const shown = (key) => (view === 'ideas' ? n(key).ideas : view === 'review' ? n(key).drafted : n(key).history);
  const now = n(type);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="toggle overflow-x-auto max-w-full" role="tablist" aria-label="Kind of content">
          {CONTENT_TYPES.map((t) => {
            const urgent = view === 'ideas' ? n(t.key).ideas : view === 'review' ? n(t.key).waiting : 0;
            return (
              <Link key={t.key} to={to(view, t.key)} role="tab" aria-selected={type === t.key} className={type === t.key ? 'is-on' : ''} style={{ gap: 6 }}>
                {t.label}
                {urgent > 0 ? <Badge tone="red">{urgent}</Badge> : <span className="text-faint">{shown(t.key)}</span>}
              </Link>
            );
          })}
        </div>
        <span className="hidden md:inline text-[13px] text-faint">{view === 'ideas' ? 'Red counts are ideas waiting for your pick' : view === 'review' ? 'Red counts are drafts waiting for you' : 'Showing what went live'}</span>
      </div>

      <div className="grid gap-0 mb-5 items-stretch" style={{ gridTemplateColumns: '1fr 22px 1fr 22px 1fr' }}>
        {STEPS.map((s, i) => {
          const count = s.id === 'ideas' ? now.ideas : s.id === 'review' ? now.drafted : now.history;
          const hot = (s.id === 'ideas' && now.ideas > 0) || (s.id === 'review' && now.waiting > 0);
          const on = view === s.id;
          return (
            <div key={s.id} className="contents">
              {i > 0 && <span aria-hidden className="grid place-items-center text-faint-2" style={{ gridColumn: i === 1 ? '2' : '4' }}>›</span>}
              <Link to={to(s.id, type)} aria-current={on ? 'page' : undefined} className="rounded-[14px] px-4.5 py-3.5 relative block"
                style={{ background: on ? '#fff' : 'var(--tray)', boxShadow: on ? '0 0 0 2px var(--fg)' : '0 0 0 1px var(--tray-ring)', padding: '14px 18px', gridColumn: i === 0 ? '1' : i === 1 ? '3' : '5' }}>
                <span className={`float-right text-[30px] leading-none font-semibold tracking-[-0.03em] tnum ${hot ? 'text-primary' : 'text-fg'}`}>{count}</span>
                <span className="text-sm font-semibold text-fg">{s.label}</span>
                <span className="block text-[12.5px] text-faint mt-0.5 max-w-[78%]">{s.id === 'review' && now.waiting > 0 ? `${now.waiting} waiting for you` : s.sub}</span>
              </Link>
            </div>
          );
        })}
      </div>
    </>
  );
}
