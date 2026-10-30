import { useState } from 'react';
import { api } from '../api.js';
import './superrank-login.css';

// Request an account. This does NOT open an account: a person at SuperRank approves every
// request first (server/routes/login.js POST /signup-requests, then staff approval under Account
// settings → Platform → Approval requests), and the page says so up front and again afterwards,
// so nobody waits for a sign-in that is not coming yet. Same look as the sign-in page (it reuses
// its styles).
const SITE = 'https://superrank.si';
const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

const ROLES = ['Founder or owner', 'Marketing', 'SEO', 'Agency or consultant', 'Developer', 'Other'];
const SOURCES = ['Google search', 'An AI assistant (ChatGPT, Perplexity…)', 'Social media', 'Friend or colleague', 'Event or webinar', 'Other'];

const ERRORS = {
  fullName: 'Enter your full name.',
  contactEmail: 'Enter a valid work email.',
  companyName: 'Enter your company name.',
  role: 'Choose your role.',
  roleOther: 'Tell us your role.',
  password: 'Choose a password of at least 8 characters.',
  terms: 'Please accept the Terms and Privacy policy.',
};

export default function SuperRankSignup() {
  const [form, setForm] = useState({ fullName: '', contactEmail: '', password: '', companyName: '', websiteDomain: '', role: '', roleOther: '', heardFrom: '', heardOther: '', terms: false, honeypot: '' });
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState('');
  const [bad, setBad] = useState({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // the server's confirmation text once submitted

  const set = (k) => (e) => { const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value; setForm((f) => ({ ...f, [k]: v })); setBad((b) => ({ ...b, [k]: false })); setErr(''); };

  const submit = async (e) => {
    e.preventDefault();
    const problems = {};
    if (!form.fullName.trim()) problems.fullName = true;
    if (!validEmail(form.contactEmail.trim())) problems.contactEmail = true;
    if (form.password.length < 8) problems.password = true;
    if (!form.companyName.trim()) problems.companyName = true;
    if (!form.role) problems.role = true;
    else if (form.role === 'Other' && !form.roleOther.trim()) problems.roleOther = true;
    if (!form.terms) problems.terms = true;
    const first = Object.keys(ERRORS).find((k) => problems[k]);
    if (first) { setBad(problems); setErr(ERRORS[first]); return; }
    setBusy(true); setErr('');
    try {
      const heardFrom = form.heardFrom === 'Other' ? (form.heardOther.trim() || 'Other') : form.heardFrom;
      const r = await api.submitSignupRequest({
        fullName: form.fullName.trim(), contactEmail: form.contactEmail.trim(), password: form.password,
        companyName: form.companyName.trim(), websiteDomain: form.websiteDomain.trim() || undefined,
        role: form.role === 'Other' ? form.roleOther.trim() : form.role,
        heardFrom: heardFrom || undefined, termsAccepted: true, honeypot: form.honeypot,
      });
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
          <section className="sr-card">
            <div className="sr-card__ok" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
            </div>
            <p className="sr-auth__eyebrow">Request received</p>
            <h1><em>Thanks{form.fullName.trim() ? `, ${form.fullName.trim().split(/\s+/)[0]}` : ''}.</em> We have it.</h1>
            <p className="sr-auth__sub">A person at SuperRank checks every new account before it opens. We will email <b style={{ color: 'var(--sr-fg)' }}>{form.contactEmail.trim()}</b> as soon as yours is approved.</p>
            <ol className="sr-timeline">
              <li className="is-done"><i>✓</i><div><b>Request sent</b><br />{form.companyName.trim()}</div></li>
              <li className="is-on"><i>2</i><div><b>We review it</b><br />Usually within one working day</div></li>
              <li><i>3</i><div><b>You get an email</b><br />With a button to sign in</div></li>
              <li><i>4</i><div><b>Set up your workspace</b><br />Name it, then add your first project</div></li>
            </ol>
            <p className="sr-auth__note" style={{ marginTop: 14 }}>Nothing is active until it is approved, so there is nothing to sign in to yet.</p>
          </section>
        ) : (
          <section className="sr-auth__view sr-auth__view--wide">
            <p className="sr-auth__eyebrow">Get started</p>
            <h1><em>Let your agent</em> start working.</h1>
            <p className="sr-auth__sub">Create your account. A person at SuperRank approves every new account, then you confirm your email, sign in, and set up your workspace and first project.</p>

            <form className="sr-auth__form" onSubmit={submit} noValidate>
              {/* Hidden from people; a bot that fills every field is quietly ignored by the server. */}
              <input type="text" name="website_url" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.honeypot} onChange={set('honeypot')} style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />
              <div className="sr-fld-row">
                <label className="sr-fld"><span>Full name</span>
                  <input type="text" name="name" autoComplete="name" autoFocus placeholder="Jane Doe" value={form.fullName} className={bad.fullName ? 'is-bad' : ''} onChange={set('fullName')} /></label>
                <label className="sr-fld"><span>Work email</span>
                  <input type="email" name="email" autoComplete="username" placeholder="name@company.com" value={form.contactEmail} className={bad.contactEmail ? 'is-bad' : ''} onChange={set('contactEmail')} /></label>
              </div>
              <label className="sr-fld"><span>Password</span>
                <span className="sr-fld__pw">
                  <input type={showPw ? 'text' : 'password'} name="password" autoComplete="new-password" placeholder="At least 8 characters" value={form.password} className={bad.password ? 'is-bad' : ''} onChange={set('password')} />
                  <button type="button" className={`sr-fld__eye${showPw ? ' is-on' : ''}`} aria-label={showPw ? 'Hide password' : 'Show password'} aria-pressed={showPw} onClick={() => setShowPw((s) => !s)}>
                    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M1.8 10S5 4.5 10 4.5 18.2 10 18.2 10 15 15.5 10 15.5 1.8 10 1.8 10Z" /><circle cx="10" cy="10" r="2.6" /><path className="sr-fld__slash" d="M3 3l14 14" />
                    </svg>
                  </button>
                </span></label>
              <div className="sr-fld-row">
                <label className="sr-fld"><span>Company name</span>
                  <input type="text" name="company" autoComplete="organization" placeholder="Acme Marketing" value={form.companyName} className={bad.companyName ? 'is-bad' : ''} onChange={set('companyName')} /></label>
                <label className="sr-fld"><span>Website <em className="sr-auth__tag">Optional</em></span>
                  <input type="text" name="website" autoComplete="url" placeholder="acme.com" value={form.websiteDomain} onChange={set('websiteDomain')} /></label>
              </div>
              <label className="sr-fld"><span>Your role</span>
                <select name="role" required value={form.role} className={bad.role ? 'is-bad' : ''} onChange={set('role')}>
                  <option value="" disabled>Choose your role</option>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select></label>
              {form.role === 'Other' && (
                <label className="sr-fld"><span>What is your role?</span>
                  <input type="text" name="role-other" placeholder="e.g. Head of growth" value={form.roleOther} className={bad.roleOther ? 'is-bad' : ''} onChange={set('roleOther')} /></label>
              )}
              <label className="sr-fld"><span>How did you hear about us? <em className="sr-auth__tag">Optional</em></span>
                <select name="heard" required value={form.heardFrom} onChange={set('heardFrom')}>
                  <option value="" disabled>Choose one</option>
                  {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select></label>
              {form.heardFrom === 'Other' && (
                <label className="sr-fld"><span>Where?</span>
                  <input type="text" name="heard-other" value={form.heardOther} onChange={set('heardOther')} /></label>
              )}
              <label className={`sr-check${bad.terms ? ' is-bad' : ''}`}>
                <input type="checkbox" name="terms" checked={form.terms} onChange={set('terms')} />
                <span>I agree to the <a href={`${SITE}/terms`} target="_blank" rel="noreferrer">Terms</a> and <a href={`${SITE}/terms`} target="_blank" rel="noreferrer">Privacy policy</a>.</span>
              </label>
              {err && <p className="sr-auth__err" role="alert">{err}</p>}
              <button type="submit" className="sr-auth__submit" disabled={busy} aria-busy={busy}>
                <span>{busy ? 'Sending…' : 'Create account'}</span>
                <span className="sr-auth__kbd" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 3 5 5-5 5" /></svg></span>
              </button>
              <p className="sr-auth__note">Your account is not active until it is approved and you confirm your email.</p>
            </form>

            <div className="sr-auth__switch">Already have an account? <a href="/login" className="sr-auth__link">Sign in</a></div>
          </section>
        )}
      </main>
    </div>
  );
}
