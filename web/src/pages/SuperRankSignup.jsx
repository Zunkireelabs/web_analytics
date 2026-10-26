import { useState } from 'react';
import { api } from '../api.js';
import './superrank-login.css';

// Request an account. This does NOT open an account: a person at SuperRank approves every
// request first (server/routes/login.js POST /signup-requests, then staff approval on the Clients
// page), and the page says so up front and again afterwards, so nobody waits for a sign-in that is
// not coming yet. Same look as the sign-in page (it reuses its styles).
const SITE = 'https://superrank.si';
const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

export default function SuperRankSignup() {
  const [form, setForm] = useState({ companyName: '', websiteDomain: '', contactEmail: '', password: '', message: '', honeypot: '' });
  const [err, setErr] = useState('');
  const [bad, setBad] = useState({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // the server's confirmation text once submitted

  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setBad((b) => ({ ...b, [k]: false })); setErr(''); };

  const submit = async (e) => {
    e.preventDefault();
    const problems = {};
    if (!form.companyName.trim()) problems.companyName = true;
    if (!validEmail(form.contactEmail.trim())) problems.contactEmail = true;
    if (form.password.length < 8) problems.password = true;
    if (Object.keys(problems).length) {
      setBad(problems);
      setErr(problems.companyName ? 'Enter your company name.' : problems.contactEmail ? 'Enter a valid work email.' : 'Choose a password of at least 8 characters.');
      return;
    }
    setBusy(true); setErr('');
    try {
      const r = await api.submitSignupRequest({ ...form, companyName: form.companyName.trim(), contactEmail: form.contactEmail.trim(), websiteDomain: form.websiteDomain.trim() || undefined, message: form.message.trim() || undefined });
      setDone(r?.message || 'Thanks, we have your request. A person at SuperRank checks every new account before it opens, and we will email you as soon as yours is approved.');
    } catch (ex) {
      setErr(ex.message || 'Could not send your request. Please try again.');
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

        {done ? (
          <section className="sr-auth__view">
            <p className="sr-auth__eyebrow">Request received</p>
            <h1><em>Thanks.</em> We will be in touch.</h1>
            <p className="sr-auth__sub">{done}</p>
            <ol className="sr-auth__note" style={{ marginTop: 18, textAlign: 'left', paddingLeft: 18, lineHeight: '20px' }}>
              <li>We check your request.</li>
              <li>We email <b>{form.contactEmail.trim()}</b> a link to confirm it is yours.</li>
              <li>You sign in and set up your first project.</li>
            </ol>
            <p className="sr-auth__note" style={{ marginTop: 10 }}>Until you confirm, your account is not active, so there is nothing to sign in to yet.</p>
            <div className="sr-auth__switch"><a href="/login" className="sr-auth__link">Back to sign in</a></div>
          </section>
        ) : (
          <section className="sr-auth__view">
            <p className="sr-auth__eyebrow">Get started</p>
            <h1><em>Let your agent</em> start working.</h1>
            <p className="sr-auth__sub">Tell us about your company. A person at SuperRank approves every new account, then you confirm your email, sign in, and set up your first project.</p>

            <form className="sr-auth__form" onSubmit={submit} noValidate>
              {/* Hidden from people; a bot that fills every field is quietly ignored by the server. */}
              <input type="text" name="website_url" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.honeypot} onChange={set('honeypot')} style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />
              <label className="sr-fld"><span>Company name</span>
                <input type="text" name="company" autoComplete="organization" autoFocus placeholder="Acme Marketing" value={form.companyName} className={bad.companyName ? 'is-bad' : ''} onChange={set('companyName')} /></label>
              <label className="sr-fld"><span>Website <em className="sr-auth__tag">Optional</em></span>
                <input type="text" name="website" autoComplete="url" placeholder="acme.com" value={form.websiteDomain} onChange={set('websiteDomain')} /></label>
              <label className="sr-fld"><span>Work email</span>
                <input type="email" name="email" autoComplete="username" placeholder="name@company.com" value={form.contactEmail} className={bad.contactEmail ? 'is-bad' : ''} onChange={set('contactEmail')} /></label>
              <label className="sr-fld"><span>Password</span>
                <input type="password" name="password" autoComplete="new-password" placeholder="At least 8 characters" value={form.password} className={bad.password ? 'is-bad' : ''} onChange={set('password')} /></label>
              <label className="sr-fld"><span>Anything we should know? <em className="sr-auth__tag">Optional</em></span>
                <input type="text" name="message" placeholder="What you hope SuperRank will do for you" value={form.message} onChange={set('message')} /></label>
              {err && <p className="sr-auth__err" role="alert">{err}</p>}
              <button type="submit" className="sr-auth__submit" disabled={busy} aria-busy={busy}>
                <span>{busy ? 'Sending…' : 'Request access'}</span>
                <span className="sr-auth__kbd" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 3 5 5-5 5" /></svg></span>
              </button>
              <p className="sr-auth__note">Your account is not active until it is approved and you confirm your email.</p>
            </form>

            <div className="sr-auth__switch">Already have an account? <a href="/login" className="sr-auth__link">Sign in</a></div>
          </section>
        )}

        <p className="sr-auth__legal">By continuing, you agree to our <a href={`${SITE}/terms`}>Terms</a> and <a href={`${SITE}/terms`}>Privacy</a>.</p>
      </main>
    </div>
  );
}
