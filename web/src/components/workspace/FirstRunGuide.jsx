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
  return (
    <div className="tray"><div className="tray-card">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-fg">Let's get you set up</h2>
        <p className="mt-1 text-[13px] text-text">Four short steps, and the first two are yours. We guide you through each.</p>
      </div>
      <ol className="px-5 pb-2" style={{ listStyle: 'none', margin: 0 }}>
        {STEPS.map((s, i) => {
          const n = i + 1, done = n < step, on = n === step;
          return (
            <li key={s.title} className="flex gap-3 py-3 border-t border-border first:border-t-0">
              <span className={`w-6 h-6 rounded-full grid place-items-center text-[12px] font-medium shrink-0 mt-0.5 ${done ? 'bg-primary-tint text-primary' : on ? 'bg-fg text-white' : 'bg-muted text-faint'}`}
                style={done ? { boxShadow: 'inset 0 0 0 1px var(--primary-ring)' } : undefined} aria-current={on ? 'step' : undefined}>
                {done ? <Check size={12} strokeWidth={3} /> : n}
              </span>
              <div className="min-w-0 flex-1">
                <div className={`text-[13px] font-medium ${on || done ? 'text-fg' : 'text-text'}`}>{s.title}</div>
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
