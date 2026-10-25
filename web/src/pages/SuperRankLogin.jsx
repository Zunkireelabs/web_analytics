import { useState } from 'react';
import { api } from '../api.js';
import './superrank-login.css';

// The /login page the superrank.si marketing site's "Log in" button lands on.
// Mirrors that site's own login page (superrank-web/src/pages/login.astro) so
// the hand-off from landing page to app looks like one product. Email +
// password only for now; the emailed-code sign-in and Google button on the
// marketing preview are not wired to anything in this app yet.
export default function SuperRankLogin({ onAuthed }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showForgot, setShowForgot] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.login(email, password);
      onAuthed();
    } catch {
      setErr('Invalid email or password.');
      setBusy(false);
    }
  };

  return (
    <div className="sr-auth">
      <main className="sr-auth__main">
        <a href="https://superrank.si" className="sr-auth__logo" aria-label="SuperRank home">
          <img src="/superrank-logo.png" alt="" />
          <span>super<b>rank</b></span>
        </a>

        <section className="sr-auth__view">
          <p className="sr-auth__eyebrow">Sign in</p>
          <h1><em>Welcome back.</em> Your agent kept working.</h1>
          <p className="sr-auth__sub">Sign in to open your workspace.</p>

          <form className="sr-auth__form" onSubmit={submit}>
            <label className="sr-fld">
              <span>Work email</span>
              <input
                type="email" name="email" autoComplete="username" autoFocus required
                placeholder="name@company.com"
                value={email} onChange={(e) => setEmail(e.target.value)}
                className={err ? 'is-bad' : ''}
              />
            </label>
            <label className="sr-fld">
              <span>Password</span>
              <input
                type="password" name="password" autoComplete="current-password" required
                placeholder="Your password"
                value={password} onChange={(e) => setPassword(e.target.value)}
                className={err ? 'is-bad' : ''}
              />
            </label>
            {err && <p className="sr-auth__err" role="alert">{err}</p>}
            <button type="submit" className="sr-auth__submit" disabled={busy} aria-busy={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="sr-auth__note">
              <button type="button" className="sr-auth__link" onClick={() => setShowForgot((s) => !s)}>Forgot password?</button>
            </p>
            {showForgot && (
              <p className="sr-auth__hint">Contact your account administrator to request a credential reset.</p>
            )}
          </form>

          <div className="sr-auth__switch">
            New here? <a href="https://superrank.si/get-started" className="sr-auth__link">Request access</a>
          </div>
        </section>
      </main>
    </div>
  );
}
