import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import './superrank-login.css';

// The app's sign-in: the SAME page as the superrank.si marketing site's /login
// (superrank-web/src/pages/login.astro), laid out exactly like it, so landing here
// from "Log in", or after signing out, looks like one product. Email + password is
// real, and so is "Email me a sign-in code instead" (a 6-digit code mailed to the address). "Continue with
// Google" is on the page as designed but has no backend yet, so it says so instead of failing.
//
// The same page is where the approval email's Sign in button lands (/login?token=…): the address is
// filled in from the link and locked, and Sign in with the password chosen at sign-up also uses the link.
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

const CODE_LEN = 6;
const RESEND_SECONDS = 60;
const arrow = (
  <span className="sr-auth__kbd" aria-hidden="true">
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 3 5 5-5 5" /></svg>
  </span>
);

// Six boxes for the emailed code. Typing moves along, backspace moves back, and pasting the whole code
// fills them all; it submits itself when the sixth digit lands.
function CodeBoxes({ value, onChange, onComplete, bad }) {
  const refs = useRef([]);
  const digits = Array.from({ length: CODE_LEN }, (_, i) => value[i] || '');
  const set = (next) => { onChange(next); if (next.length === CODE_LEN) onComplete(next); };
  const type = (i, raw) => {
    const d = raw.replace(/\D/g, '');
    if (!d) return;
    const next = (value.slice(0, i) + d).slice(0, CODE_LEN);
    set(next);
    refs.current[Math.min(next.length, CODE_LEN - 1)]?.focus();
  };
  const key = (i, e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      onChange(value.slice(0, digits[i] ? i : Math.max(0, i - 1)));
      refs.current[Math.max(0, digits[i] ? i : i - 1)]?.focus();
    }
  };
  const paste = (e) => {
    const d = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, CODE_LEN);
    if (!d) return;
    e.preventDefault();
    set(d);
    refs.current[Math.min(d.length, CODE_LEN - 1)]?.focus();
  };
  return (
    <div className={`sr-otp${bad ? ' is-bad' : ''}`} onPaste={paste}>
      {digits.map((d, i) => (
        <input key={i} ref={(el) => { refs.current[i] = el; }} value={d} inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={CODE_LEN} aria-label={`Digit ${i + 1} of ${CODE_LEN}`} autoFocus={i === 0}
          onChange={(e) => type(i, e.target.value)} onKeyDown={(e) => key(i, e)} onFocus={(e) => e.target.select()} />
      ))}
    </div>
  );
}

export default function SuperRankLogin({ onAuthed }) {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [last] = useState(readLast);
  const [email, setEmail] = useState(last);
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState('');
  const [bad, setBad] = useState({});
  const [busy, setBusy] = useState(false);
  // password | code (waiting for the six digits) | invite (arrived from the approval email) | badlink
  // /reset-password?token=… is the link in the admin password-reset email: choose a new password, no sign-in needed.
  const isReset = window.location.pathname === '/reset-password';
  const [mode, setMode] = useState(isReset ? 'reset' : token ? 'checking' : 'password');
  const [resetDone, setResetDone] = useState(false);
  const [invite, setInvite] = useState(null);
  // On the approval link: choose a new password instead of typing the one from sign-up.
  const [resetPw, setResetPw] = useState(false);
  // On the approval link the default is one button (the emailed link is the proof); the password form is the alternative.
  const [usePw, setUsePw] = useState(false);
  const [code, setCode] = useState('');
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (!token || isReset) return;
    api.signupVerify.peek(token)
      .then((r) => { setInvite(r); setEmail(r.email); setMode('invite'); })
      .catch((e) => { setErr(e.message || 'This link is not valid, or it was already used.'); setMode('badlink'); });
  }, [token]);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const clear = (field) => { setBad((b) => ({ ...b, [field]: false })); setErr(''); };
  const remember = (clean) => { try { localStorage.setItem(LAST, clean); } catch { /* storage unavailable */ } };

  const submitReset = async (e) => {
    e.preventDefault();
    if (password.length < 8) { setBad({ password: true }); setErr('Use at least 8 characters.'); return; }
    setBusy(true); setErr(''); setBad({});
    try {
      await api.passwordReset(token, password);
      setResetDone(true);
      window.history.replaceState({}, '', '/login');
    } catch (ex) {
      setErr(ex.status >= 500 || !ex.status ? 'We could not reset the password just now. Please try again in a moment.' : (ex.message || 'This reset link is invalid or has expired.'));
    }
    setBusy(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    const clean = email.trim();
    if (!validEmail(clean)) { setBad({ email: true }); setErr('Enter a valid work email.'); return; }
    if (!password) { setBad({ password: true }); setErr(resetPw ? 'Choose a password.' : 'Enter your password.'); return; }
    if (resetPw && password.length < 8) { setBad({ password: true }); setErr('Use at least 8 characters.'); return; }
    setBusy(true);
    setErr('');
    setBad({});
    try {
      if (mode === 'invite') await (resetPw ? api.signupActivate(token, '', password) : api.signupActivate(token, password));
      else await api.login(clean, password);
      remember(clean);
      // A used approval link must not stay in the address bar.
      if (mode === 'invite') { window.location.replace('/'); return; }
      onAuthed();
    } catch (ex) {
      if (mode === 'invite') { setErr(ex.message || 'Could not sign you in.'); setBad({ password: true }); }
      else if (ex.status === 429 || ex.status === 403) { setErr(ex.message); } // too many tries / account disabled or without a workspace
      else if (ex.status >= 500 || !ex.status) { setErr('We could not sign you in just now. Please try again in a moment.'); }
      else { setErr('Invalid email or password.'); setBad({ email: true, password: true }); }
      setBusy(false);
    }
  };

  const continueIn = async () => {
    setBusy(true); setErr('');
    try {
      await api.signupContinue(token);
      remember(email.trim());
      // A fresh page load: a used link must not stay in the address bar, and nothing of an account that was
      // already signed in on this browser may linger in the app.
      window.location.replace('/');
    } catch (ex) {
      setErr(ex.status >= 500 || !ex.status ? 'We could not sign you in just now. Please try again in a moment.' : (ex.message || 'Could not sign you in.'));
      setBusy(false);
    }
  };

  const sendCode = async () => {
    const clean = email.trim();
    if (!validEmail(clean)) { setBad({ email: true }); setErr('Enter your work email first, then ask for a code.'); return; }
    setBusy(true); setErr(''); setBad({});
    try {
      await api.loginCode.send(clean);
      setCode(''); setWait(RESEND_SECONDS); setMode('code');
    } catch (ex) { setErr(ex.message || 'Could not send a code. Try again.'); }
    setBusy(false);
  };

  const verifyCode = async (full) => {
    if (busy) return;
    setBusy(true); setErr(''); setBad({});
    try {
      await api.loginCode.verify(email.trim(), full);
      remember(email.trim());
      onAuthed();
    } catch (ex) {
      setErr(ex.message || 'That code is not right.'); setBad({ code: true }); setCode(''); setBusy(false);
    }
  };

  const logo = (
    <a href={SITE} className="sr-auth__logo" aria-label="SuperRank home">
      <img src="/superrank-logo.png" alt="" />
      <span>super<b>rank</b></span>
    </a>
  );
  const showPassword = mode === 'password' || mode === 'invite';

  return (
    <div className="sr-auth">
      <main className="sr-auth__main">
        {logo}

        {mode === 'checking' && <section className="sr-auth__view"><p className="sr-auth__sub">Checking your link…</p></section>}

        {mode === 'reset' && (
          <section className="sr-auth__view">
            {resetDone ? (
              <>
                <p className="sr-auth__eyebrow">Password changed</p>
                <h1><em>All set.</em> Sign in with your new password.</h1>
                <div className="sr-auth__switch"><a href="/login" className="sr-auth__link">Go to sign in</a></div>
              </>
            ) : (
              <>
                <p className="sr-auth__eyebrow">Reset password</p>
                <h1>Choose a new password</h1>
                <form className="sr-auth__form" onSubmit={submitReset} noValidate>
                  <label className="sr-fld">
                    <span>New password</span>
                    <input type="password" name="password" autoComplete="new-password" autoFocus placeholder="At least 8 characters"
                      value={password} className={bad.password ? 'is-bad' : ''} onChange={(e) => { setPassword(e.target.value); clear('password'); }} />
                  </label>
                  {err && <p className="sr-auth__err" role="alert">{err}</p>}
                  <button type="submit" className="sr-auth__submit" disabled={busy || !token} aria-busy={busy}>
                    <span>{busy ? 'Saving…' : 'Set password'}</span>{arrow}
                  </button>
                </form>
              </>
            )}
          </section>
        )}

        {mode === 'badlink' && (
          <section className="sr-auth__view">
            <p className="sr-auth__eyebrow">This link did not work</p>
            <h1>We could not open that.</h1>
            <p className="sr-auth__err" role="alert" style={{ marginTop: 18 }}>{err}</p>
            <div className="sr-auth__switch">Already approved? <a href="/login" className="sr-auth__link">Sign in</a></div>
          </section>
        )}

        {mode === 'code' && (
          <section className="sr-auth__view">
            <p className="sr-auth__eyebrow">Check your email</p>
            <h1>Enter your code</h1>
            <p className="sr-auth__sub">We sent a 6-digit code to <b style={{ color: 'var(--sr-fg)' }}>{email.trim()}</b>.</p>
            <CodeBoxes value={code} onChange={(v) => { setCode(v); setErr(''); setBad({}); }} onComplete={verifyCode} bad={bad.code} />
            {err && <p className="sr-auth__err" role="alert" style={{ marginTop: 14 }}>{err}</p>}
            <div className="sr-auth__form" style={{ marginTop: 18 }}>
              <button type="button" className="sr-auth__submit" disabled={busy || code.length < CODE_LEN} aria-busy={busy} onClick={() => verifyCode(code)}>
                <span>{busy ? 'Signing in…' : 'Sign in'}</span>{arrow}
              </button>
            </div>
            <p className="sr-auth__resend">
              Didn't get it?{' '}
              {wait > 0
                ? <>Send again in {Math.floor(wait / 60)}:{String(wait % 60).padStart(2, '0')}</>
                : <button type="button" className="sr-auth__link" onClick={sendCode} disabled={busy}>Send again</button>}
              {' · '}
              <button type="button" className="sr-auth__link" onClick={() => { setMode('password'); setCode(''); setErr(''); }}>Use my password instead</button>
            </p>
          </section>
        )}

        {mode === 'invite' && !usePw && (
          <section className="sr-auth__view">
            <p className="sr-auth__eyebrow">Account approved</p>
            <h1><em>Your account is approved.</em> Welcome.</h1>
            <p className="sr-auth__sub">{invite?.companyName ? `${invite.companyName} is approved. ` : ''}Continue to open your workspace.</p>
            <div className="sr-auth__form">
              <label className="sr-fld">
                <span>Work email <em className="sr-auth__tag">From your invite</em></span>
                <input type="email" name="email" value={email} readOnly />
              </label>
              {err && <p className="sr-auth__err" role="alert">{err}</p>}
              <button type="button" className="sr-auth__submit" onClick={continueIn} disabled={busy} aria-busy={busy} autoFocus>
                <span>{busy ? 'Signing in…' : 'Continue'}</span>{arrow}
              </button>
              <p className="sr-auth__note">
                <button type="button" className="sr-auth__link" onClick={() => { setUsePw(true); setErr(''); }}>I'd rather sign in with my password</button>
              </p>
              <p className="sr-auth__note" style={{ opacity: .75 }}>Next time you can sign in with an emailed code, or set a password in your account settings.</p>
            </div>
          </section>
        )}

        {showPassword && !(mode === 'invite' && !usePw) && (
          <section className="sr-auth__view">
            {mode === 'invite' ? (
              <>
                <p className="sr-auth__eyebrow">Account approved</p>
                <h1><em>Your account is approved.</em> Sign in to start.</h1>
                <p className="sr-auth__sub">{invite?.companyName ? `${invite.companyName} is approved. ` : ''}{resetPw ? 'Choose a password for your account.' : 'Use the password you chose when you signed up.'}</p>
              </>
            ) : (
              <>
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
              </>
            )}

            <form className="sr-auth__form" onSubmit={submit} noValidate>
              <label className="sr-fld">
                <span>Work email {mode === 'invite' ? <em className="sr-auth__tag">From your invite</em> : last && email === last && <em className="sr-auth__tag">Last used</em>}</span>
                <input type="email" name="email" autoComplete="username" autoFocus={mode === 'password'} placeholder="name@company.com" readOnly={mode === 'invite'}
                  value={email} className={bad.email ? 'is-bad' : ''} onChange={(e) => { setEmail(e.target.value); clear('email'); }} />
              </label>
              <label className="sr-fld">
                <span>{resetPw ? 'New password' : 'Password'}</span>
                <span className="sr-fld__pw">
                  <input type={showPw ? 'text' : 'password'} name="password" autoComplete={resetPw ? 'new-password' : 'current-password'} autoFocus={mode === 'invite'} placeholder={resetPw ? 'At least 8 characters' : 'Your password'}
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
                <span>{busy ? 'Signing in…' : 'Sign in'}</span>{arrow}
              </button>
              {mode === 'invite' && (
                <p className="sr-auth__note">
                  <button type="button" className="sr-auth__link" onClick={() => { setResetPw((v) => !v); setPassword(''); setErr(''); setBad({}); }}>
                    {resetPw ? 'I remember my password' : "I don't remember my password"}
                  </button>
                  {' · '}
                  <button type="button" className="sr-auth__link" onClick={() => { setUsePw(false); setResetPw(false); setPassword(''); setErr(''); setBad({}); }}>Continue without a password</button>
                </p>
              )}
              {/* A code can only be sent to an account that exists, and an invited account is created by this very sign-in. */}
              {mode === 'password' && (
                <p className="sr-auth__note">
                  <button type="button" className="sr-auth__link" onClick={sendCode} disabled={busy}>Email me a sign-in code instead</button>
                </p>
              )}
            </form>

            {mode === 'password' && (
              <div className="sr-auth__switch">
                Don't have an account? <a href="/signup" className="sr-auth__link">Sign up</a>
              </div>
            )}
          </section>
        )}

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
