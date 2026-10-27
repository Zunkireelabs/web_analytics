import { useEffect, useState } from 'react';
import { Clock, ListChecks, ShieldCheck, LineChart, Sparkles, GitPullRequest, Users } from 'lucide-react';
import { api } from '../../api.js';
import { canManageWorkspace } from '../../lib/workspace.js';
import FirstRunGuide from './FirstRunGuide.jsx';
import NewProjectModal from './NewProjectModal.jsx';

// Under the guide, outside its box: what to expect, in the same small-card style as the rest of the app.
const INFO = [
  { icon: Clock, title: 'About 3 minutes', text: 'Name the project, say what you want to grow, and connect Google and your repository. SuperRank then builds your baseline.' },
  { icon: ListChecks, title: 'Have these ready', text: "Your website's address, access to its Search Console and Analytics, and the repository its code lives in." },
  { icon: ShieldCheck, title: 'You stay in control', text: 'Nothing is merged or published on your site without your approval, and every change comes with its reason.' },
];

// The row under both columns: what the account shows once the project is connected.
const GAIN = [
  { icon: LineChart, title: 'Search performance', text: 'Clicks, impressions and rankings from Search Console, tracked every day.' },
  { icon: Sparkles, title: 'AI visibility', text: 'Where your site is seen in ChatGPT and other AI answers, prompt by prompt.' },
  { icon: GitPullRequest, title: 'Fixes from your agent', text: 'Each morning the agent prepares fixes as pull requests for you to review.' },
  { icon: Users, title: 'Competitors', text: 'Who ranks ahead of you, and in what ways they are ahead.' },
];

const ASKED_KEY = 'add-first-project-asked';
const alreadyAsked = () => { try { return sessionStorage.getItem(ASKED_KEY) === '1'; } catch { return false; } };
const markAsked = () => { try { sessionStorage.setItem(ASKED_KEY, '1'); } catch { /* storage unavailable */ } };

// What every project page shows for someone who has a workspace but no project yet: the same
// "Let's get you set up" guide as the Workspace page, on step 2, so the sidebar can be used
// freely without any page failing for lack of a project. The New project popup also opens by
// itself the first time they land here in a session, on a clean page; closing it leaves this guide, with the
// button, to come back to.
export default function NoProjectGate({ onOpenProject }) {
  const [workspace, setWorkspace] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.workspaces().then((r) => {
      const mine = (r.workspaces || []).find((w) => canManageWorkspace(w.role)) || null;
      setWorkspace(mine);
      if (mine && !alreadyAsked()) { markAsked(); setOpen(true); }
    }).catch(() => {}).finally(() => setLoaded(true));
  }, []);

  if (!loaded) return <div className="p-8 text-faint">Loading…</div>;
  return (
    // Starts near the top like the other pages, and fills the page width: the guide on the left, what to expect
    // stacked beside it, so there is no band of empty space above, below or around it.
    <div className="max-w-[1040px] mx-auto px-4 md:px-6 pt-6 pb-10">
      {/* While the New project popup is open it is the whole screen: the guide is only what is left behind when
          the popup is closed or skipped, so it is not shown underneath it. */}
      {!open && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
          <FirstRunGuide step={2} canAct={!!workspace} actionLabel="Add your first project" onAction={() => setOpen(true)} />
          {/* The three cards share the guide's height, so both columns end on the same line, and each card's text sits in the middle of its box. */}
          <div className="grid gap-3 lg:auto-rows-fr">
            {INFO.map(({ icon: Icon, title, text }) => (
              <div key={title} className="rounded-card bg-white px-4 py-4 flex flex-col justify-center" style={{ boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' }}>
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-control bg-primary-tint text-primary grid place-items-center shrink-0"><Icon size={13} /></span>
                  <span className="text-[13px] font-medium text-fg">{title}</span>
                </div>
                <p className="mt-2 text-xs leading-[18px] text-faint">{text}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {!open && (
        <section className="mt-7">
          <p className="text-[11px] font-medium uppercase tracking-[.1em] text-faint">What you'll get once it's connected</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {GAIN.map(({ icon: Icon, title, text }) => (
              <div key={title} className="rounded-card bg-white px-4 py-4" style={{ boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' }}>
                <span className="w-8 h-8 rounded-control bg-primary-tint text-primary grid place-items-center" style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}><Icon size={15} /></span>
                <div className="mt-3 text-[13px] font-medium text-fg">{title}</div>
                <p className="mt-1 text-xs leading-[18px] text-faint">{text}</p>
              </div>
            ))}
          </div>
        </section>
      )}
      {open && workspace && (
        <NewProjectModal workspace={workspace} first isOpen onClose={() => setOpen(false)}
          onChanged={() => {}} onOpenProject={(p) => p && onOpenProject(p)} />
      )}
    </div>
  );
}
