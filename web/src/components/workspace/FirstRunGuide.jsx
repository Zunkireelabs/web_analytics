import { Check } from 'lucide-react';
import Button from '../Button.jsx';

// What a new account sees on the Workspace page instead of an empty screen: the four
// things that happen between signing in and a working project, with the current one
// highlighted and the action for it right there. It replaces "You are not in a
// workspace yet" — which told someone what was missing without saying what to do.
//
//   step 1  no workspace yet            → name one
//   step 2  a workspace, no project     → add the first project
//
// Steps 3 and 4 are shown so the whole path is visible from the start; they happen
// inside the New project popup, so they carry no button of their own here.
const STEPS = [
  { title: 'Name your workspace', body: 'A workspace holds your projects and the people who can see them. Usually your company or team name.' },
  { title: 'Add your first project', body: 'A project is one website you want to grow. Give it a name and its address, and say what you want to achieve.' },
  { title: 'Connect Google and your repository', body: 'Search Console and Analytics tell SuperRank how the site performs. The repository lets the agent prepare fixes as pull requests. SuperRank connects both for you for now.' },
  { title: 'Your baseline builds', body: 'SuperRank reads your data and your site and tells you where you stand. It takes a few minutes, and you land on your Overview when there is something to see.' },
];

export default function FirstRunGuide({ step, onAction, actionLabel, canAct = true }) {
  const doneCount = Math.max(0, Math.min(STEPS.length, step - 1));
  return (
    <div className="tray"><div className="tray-card">
      <div className="px-5 pt-5 pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[.1em] text-primary">Getting started</p>
            <h2 className="mt-1 text-[19px] leading-6 font-semibold tracking-[-0.02em] text-fg">Let's get you set up</h2>
            <p className="mt-1 text-[13px] text-text">Four short steps, and the first two are yours. We guide you through each.</p>
          </div>
          <span className="shrink-0 mt-0.5 text-xs text-faint whitespace-nowrap">{doneCount} of {STEPS.length} done</span>
        </div>
        <div className="mt-4 flex gap-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={doneCount} aria-label="Setup progress">
          {STEPS.map((s, i) => (
            <span key={s.title} className="h-1 flex-1 rounded-full" style={{ background: i < doneCount ? 'var(--primary)' : i === doneCount ? 'var(--primary-ring)' : 'var(--border-2)' }} />
          ))}
        </div>
      </div>
      <ol className="px-5 pb-5" style={{ listStyle: 'none', margin: 0 }}>
        {STEPS.map((s, i) => {
          const n = i + 1, done = n < step, on = n === step, last = i === STEPS.length - 1;
          return (
            <li key={s.title} className="relative flex gap-3.5 pb-3 last:pb-0">
              {/* The line joining each step to the next. */}
              {!last && <span className="absolute left-[11px] top-7 bottom-0 w-px" style={{ background: done ? 'var(--primary-ring)' : 'var(--border-2)' }} aria-hidden="true" />}
              <span className={`relative z-10 w-6 h-6 rounded-full grid place-items-center text-[12px] font-medium shrink-0 mt-1 ${done ? 'bg-primary-tint text-primary' : on ? 'bg-fg text-white' : 'bg-muted text-faint'}`}
                style={done ? { boxShadow: 'inset 0 0 0 1px var(--primary-ring)' } : undefined} aria-current={on ? 'step' : undefined}>
                {done ? <Check size={12} strokeWidth={3} /> : n}
              </span>
              <div className={`min-w-0 flex-1 rounded-card ${on ? 'bg-primary-tint px-4 py-3.5' : 'px-1 py-1'}`}
                style={on ? { boxShadow: 'inset 0 0 0 1px var(--primary-ring)' } : undefined}>
                <div className="flex items-center gap-2">
                  <div className={`text-[13px] font-medium ${on || done ? 'text-fg' : 'text-text'}`}>{s.title}</div>
                  {done && <span className="text-[11px] text-primary">Done</span>}
                </div>
                <p className={`mt-0.5 text-xs leading-[18px] ${on ? 'text-text' : 'text-faint'}`}>{s.body}</p>
                {on && onAction && canAct && <div className="mt-3"><Button variant="primary" onClick={onAction}>{actionLabel}</Button></div>}
              </div>
            </li>
          );
        })}
      </ol>
    </div></div>
  );
}
