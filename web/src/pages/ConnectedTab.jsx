import { useEffect, useState } from 'react';
import { Check, AlertTriangle } from 'lucide-react';
import { findWaitingTab } from '../lib/connect-tab.js';

// Where GitHub / PostHog send the NEW tab back to (via the server's callback). It hands the outcome to the SuperRank tab
// that started the connection and asks the person to close this one. With no SuperRank tab waiting, it carries on to
// the Workspace page exactly as before, so a connection is never lost. See lib/connect-tab.js.
const NAMES = { github: 'GitHub', posthog: 'PostHog' };
const KEYS = ['ws', 'finish', 'step', 'github', 'gherror', 'posthog', 'pherror'];

export default function ConnectedTab() {
  const [state, setState] = useState('checking'); // checking | handed | closing
  const query = new URLSearchParams(window.location.search);
  const kind = query.get('kind') === 'posthog' ? 'posthog' : 'github';
  const name = NAMES[kind];
  const failed = Boolean(query.get(kind === 'github' ? 'gherror' : 'pherror'));
  const params = Object.fromEntries(KEYS.filter((k) => query.get(k)).map((k) => [k, query.get(k)]));

  useEffect(() => {
    let live = true;
    findWaitingTab(kind).then(({ found, send }) => {
      if (!live) return;
      if (found) { send(params); setState('handed'); return; }
      // No SuperRank tab is waiting: continue here, the way this worked before the new tab.
      window.location.replace(`/workspace?${new URLSearchParams(params)}`);
    });
    return () => { live = false; };
  }, []);

  const closeTab = () => {
    setState('closing');
    window.close();
    // A tab the browser will not let a page close stays open: say what to do instead.
    setTimeout(() => setState('handed'), 300);
  };

  if (state === 'checking') return <div className="min-h-screen bg-canvas" />;

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center p-4 text-sm">
      <div className="w-full rounded-card bg-white p-6 text-center" style={{ maxWidth: 420, boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 30px 60px -20px rgba(0,0,0,.12)' }}>
        <div className="mx-auto w-12 h-12 rounded-full grid place-items-center text-white" style={{ background: failed ? '#b42318' : 'var(--green)' }}>
          {failed ? <AlertTriangle size={22} /> : <Check size={22} strokeWidth={2.5} />}
        </div>
        <h1 className="mt-4 text-[18px] font-semibold text-fg">{failed ? `${name} was not connected` : `${name} connected`}</h1>
        <p className="mt-1.5 text-[13px] text-text leading-[19px]">
          {failed
            ? 'Go back to the SuperRank tab. It shows what happened and lets you try again.'
            : `Go back to the SuperRank tab. It has already updated${kind === 'github' ? ' and is showing your repositories' : ''}.`}
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button type="button" className="btn btn--primary w-full justify-center" onClick={closeTab}>Close this tab</button>
          <span className="text-xs text-faint">
            If the SuperRank tab is closed, <a className="text-primary font-medium" href={`/workspace?${new URLSearchParams(params)}`}>open SuperRank here</a>.
          </span>
        </div>
      </div>
    </div>
  );
}
