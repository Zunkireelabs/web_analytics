import { useState } from 'react';
import { api } from '../../api.js';
import '../../pages/superrank-login.css';

// The first thing a newly approved account sees after signing in: a workspace needs a name before
// anything else, so nothing else is shown until it has one. The company they gave at sign-up is
// filled in. Creating it tells App (workspaces:changed), which then shows the full app, and the
// project pages ask for the first project.
// The strip under the form, in the login page's card style: what comes after naming the workspace.
const NEXT = [
  { h: 'Add a project', tag: 'Your first website', text: 'A project is one website you want to grow. Adding it takes about three minutes.', who: 'Step 2 of 2', sub: 'right after this' },
  { h: 'Connect', tag: 'Google and GitHub', text: 'Search Console, Analytics and your repository, so the agent has the data and the code to work with.', who: 'You choose', sub: 'what SuperRank can see' },
  { h: 'Your click', tag: 'Review and approve', text: 'Nothing ships without your approval. Every change comes with its reason.', who: 'You stay in control', sub: 'review, then merge' },
];

export default function NameWorkspace({ suggested, email, onLogout }) {
  const [name, setName] = useState(suggested || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) { setErr('Give your workspace a name.'); return; }
    setBusy(true); setErr('');
    try {
      await api.workspace.create({ name: clean });
      window.dispatchEvent(new Event('workspaces:changed'));
    } catch (ex) {
      setErr(ex.message || 'Could not create the workspace. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="sr-auth">
      <main className="sr-auth__main">
        <span className="sr-auth__logo">
          <img src="/superrank-logo.png" alt="" />
          <span>super<b>rank</b></span>
        </span>
        <section className="sr-auth__view">
          <p className="sr-auth__eyebrow">Step 1 of 2 · Your workspace</p>
          <h1><em>Name your workspace.</em></h1>
          <p className="sr-auth__sub">It holds your projects and the people who can see them. Usually your company or team name. You can rename it later.</p>
          <form className="sr-auth__form" onSubmit={submit} noValidate>
            <label className="sr-fld">
              <span>Workspace name</span>
              <input type="text" name="workspace" autoFocus maxLength={120} placeholder="Acme Marketing" value={name}
                className={err ? 'is-bad' : ''} onChange={(e) => { setName(e.target.value); setErr(''); }} />
            </label>
            {err && <p className="sr-auth__err" role="alert">{err}</p>}
            <button type="submit" className="sr-auth__submit" disabled={busy} aria-busy={busy}>
              <span>{busy ? 'Creating…' : 'Create workspace'}</span>
              <span className="sr-auth__kbd" aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 3 5 5-5 5" /></svg>
              </span>
            </button>
          </form>
          <div className="sr-prog" aria-hidden="true"><span className="is-on" /><span /></div>
          <p className="sr-auth__note" style={{ marginTop: 10 }}>Next: add your first project.</p>
        </section>
        <p className="sr-auth__legal">Signed in as {email}. <button type="button" className="sr-auth__link" onClick={onLogout}>Sign out</button></p>
      </main>

      <section className="sr-proof">
        <p className="sr-proof__label">What happens next</p>
        <div className="sr-proof__grid">
          {NEXT.map((c) => (
            <figure className="sr-lq" key={c.tag}>
              <div className="sr-lq__h"><b>{c.h}</b><span>{c.tag}</span></div>
              <blockquote>{c.text}</blockquote>
              <figcaption><i aria-hidden="true" /><div><b>{c.who}</b><span>{c.sub}</span></div></figcaption>
            </figure>
          ))}
        </div>
      </section>
    </div>
  );
}
