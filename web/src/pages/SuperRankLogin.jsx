import { useState } from 'react';
import { api } from '../api.js';
import './superrank-login.css';

// The app's sign-in: the SAME page as the superrank.si marketing site's /login
// (superrank-web/src/pages/login.astro), laid out exactly like it, so landing here
// from "Log in", or after signing out, looks like one product. Email + password is
// real. "Continue with Google" and "Email me a sign-in code" are on the page as
// designed but have no backend yet (the marketing site's own script notes /auth/google
// and /auth/code are still to be built), so they say so instead of failing.
const LAST = 'superrank:last-email';
const SITE = 'https://superrank.si';

const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
// The approval email links to /login?email=…, so someone signing in for the first
// time lands with their address already in the box. Only a well-formed address is
// taken from the URL; anything else is ignored rather than put in a field.
const readLast = () => {
  try {
    const fromLink = new URLSearchParams(window.location.search).get('email')?.trim();
    if (fromLink && validEmail(fromLink)) return fromLink;
    return localStorage.getItem(LAST) || '';
  } catch { return ''; }
};

// Under the form: what the product does, in the same card layout the marketing page
// uses for customer quotes. These are statements of what the product does, not quotes.
const PROOF = [
  { h: 'Always synced', tag: 'Connect data', text: 'Search Console and Analytics flow in every day, with no spreadsheets to export.', who: 'Search Console', sub: 'and Google Analytics' },
  { h: 'Every signal', tag: 'AI analysis', text: 'Agents watch your rankings, pages and AI answers, and tell you what to fix first.', who: 'Evidence for every fix', sub: 'not a guess' },
  { h: 'Your click', tag: 'Review and approve', text: 'Nothing ships without your approval. Every change comes with its reason.', who: 'You stay in control', sub: 'review, then merge' },
];

export default function SuperRankLogin({ onAuthed }) {
  const [last] = useState(readLast);
  const [email, setEmail] = useState(last);
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState('');
  const [bad, setBad] = useState({});
  const [busy, setBusy] = useState(false);

  const clear = (field) => { setBad((b) => ({ ...b, [field]: false })); setErr(''); };

  const submit = async (e) => {
    e.preventDefault();
    const clean = email.trim();
    if (!validEmail(clean)) { setBad({ email: true }); setErr('Enter a valid work email.'); return; }
    if (!password) { setBad({ password: true }); setErr('Enter your password.'); return; }
    setBusy(true);
    setErr('');
    setBad({});
    try {
      await api.login(clean, password);
      try { localStorage.setItem(LAST, clean); } catch { /* storage unavailable */ }
      onAuthed();
    } catch {
      setErr('Invalid email or password.');
      setBad({ email: true, password: true });
      setBusy(false);
    }
  };

  return (
    <div className="sr-auth">
      <main className="sr-auth__main">
        <a href={SITE} className="sr-auth__logo" aria-label="SuperRank home">
          <img src="/superrank-logo.png" alt="" />
          <span>super<b>rank</b></span>
        </a>

        <section className="sr-auth__view">
          <p className="sr-auth__eyebrow">Sign in</p>
          <h1><em>Welcome back.</em> Your agent kept working.</h1>
          <p className="sr-auth__sub">Sign in to your workspace.</p>

          <button type="button" className="sr-auth__google" onClick={() => setErr('Google sign-in is not available yet. Use your email and password.')}>
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
              <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
            </svg>
            Continue with Google
          </button>
          <div className="sr-auth__or"><span>or email</span></div>

          <form className="sr-auth__form" onSubmit={submit} noValidate>
            <label className="sr-fld">
              <span>Work email {last && email === last && <em className="sr-auth__tag">Last used</em>}</span>
              <input type="email" name="email" autoComplete="username" autoFocus placeholder="name@company.com"
                value={email} className={bad.email ? 'is-bad' : ''} onChange={(e) => { setEmail(e.target.value); clear('email'); }} />
            </label>
            <label className="sr-fld">
              <span>Password</span>
              <span className="sr-fld__pw">
                <input type={showPw ? 'text' : 'password'} name="password" autoComplete="current-password" placeholder="Your password"
                  value={password} className={bad.password ? 'is-bad' : ''} onChange={(e) => { setPassword(e.target.value); clear('password'); }} />
                <button type="button" className={`sr-fld__eye${showPw ? ' is-on' : ''}`} aria-label={showPw ? 'Hide password' : 'Show password'} aria-pressed={showPw} onClick={() => setShowPw((s) => !s)}>
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M1.8 10S5 4.5 10 4.5 18.2 10 18.2 10 15 15.5 10 15.5 1.8 10 1.8 10Z" /><circle cx="10" cy="10" r="2.6" /><path className="sr-fld__slash" d="M3 3l14 14" />
                  </svg>
                </button>
              </span>
            </label>
            {err && <p className="sr-auth__err" role="alert">{err}</p>}
            <button type="submit" className="sr-auth__submit" disabled={busy} aria-busy={busy}>
              <span>{busy ? 'Signing in…' : 'Sign in'}</span>
              <span className="sr-auth__kbd" aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 3 5 5-5 5" /></svg>
              </span>
            </button>
            <p className="sr-auth__note">
              <button type="button" className="sr-auth__link" onClick={() => setErr('Sign-in codes are not available yet. Use your email and password.')}>Email me a sign-in code instead</button>
            </p>
          </form>

          <div className="sr-auth__switch">
            Don't have an account? <a href="/signup" className="sr-auth__link">Sign up</a>
          </div>
        </section>

        <p className="sr-auth__legal">By continuing, you agree to our <a href={`${SITE}/terms`}>Terms</a> and <a href={`${SITE}/terms`}>Privacy</a>.</p>
      </main>

      <section className="sr-proof">
        <p className="sr-proof__label">Built for marketing teams and SEO agencies</p>
        <div className="sr-proof__grid">
          {PROOF.map((c) => (
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
