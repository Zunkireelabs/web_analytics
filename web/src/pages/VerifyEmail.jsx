import { useEffect, useState } from 'react';
import { api } from '../api.js';
import './superrank-login.css';

// The page the approval email links to (/verify-email?token=…). It first LOOKS the link up, so it
// can say whose account this is, or that the link is used up or has expired, before anything is
// created; the account is only created when the person presses the button. The button, rather than
// doing it on load, is what keeps a mail scanner that opens links from using the link up.
const SITE = 'https://superrank.si';

export default function VerifyEmail() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [state, setState] = useState('checking'); // checking | ready | confirming | done | problem
  const [info, setInfo] = useState(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) { setState('problem'); setMessage('This link is not valid, or it was already used.'); return; }
    api.signupVerify.peek(token)
      .then((r) => { setInfo(r); setState('ready'); })
      .catch((e) => { setMessage(e.message || 'This link is not valid, or it was already used.'); setState('problem'); });
  }, [token]);

  const confirm = async () => {
    setState('confirming'); setMessage('');
    try {
      const r = await api.signupVerify.confirm(token);
      setInfo((i) => ({ ...i, email: r.email || i?.email }));
      setState('done');
    } catch (e) {
      setMessage(e.message || 'Could not confirm your email. Please try again.');
      setState('problem');
    }
  };

  const signInHref = `/login${info?.email ? `?email=${encodeURIComponent(info.email)}` : ''}`;

  return (
    <div className="sr-auth">
      <main className="sr-auth__main">
        <a href={SITE} className="sr-auth__logo" aria-label="SuperRank home">
          <img src="/superrank-logo.png" alt="" />
          <span>super<b>rank</b></span>
        </a>
        <section className="sr-auth__view">
          {state === 'checking' && <p className="sr-auth__sub">Checking your link…</p>}

          {(state === 'ready' || state === 'confirming') && (
            <>
              <p className="sr-auth__eyebrow">Confirm your email</p>
              <h1><em>Almost there.</em> One click to finish.</h1>
              <p className="sr-auth__sub">Confirm that <b>{info?.email}</b> is yours to open the account for {info?.companyName}.</p>
              <div className="sr-auth__form">
                <button type="button" className="sr-auth__submit" onClick={confirm} disabled={state === 'confirming'} aria-busy={state === 'confirming'}>
                  <span>{state === 'confirming' ? 'Confirming…' : 'Confirm my email'}</span>
                </button>
                <p className="sr-auth__note">Then you sign in with the password you chose when you signed up.</p>
              </div>
            </>
          )}

          {state === 'done' && (
            <>
              <p className="sr-auth__eyebrow">Email confirmed</p>
              <h1><em>You are in.</em> Now sign in.</h1>
              <p className="sr-auth__sub">Your account is ready. Sign in with <b>{info?.email}</b> and the password you chose. We will help you name your workspace and add your first project.</p>
              <div className="sr-auth__form"><a href={signInHref} className="sr-auth__submit" style={{ textDecoration: 'none' }}><span>Sign in</span></a></div>
            </>
          )}

          {state === 'problem' && (
            <>
              <p className="sr-auth__eyebrow">This link did not work</p>
              <h1>We could not confirm that.</h1>
              <p className="sr-auth__err" role="alert" style={{ marginTop: 18 }}>{message}</p>
              <div className="sr-auth__switch">Already confirmed? <a href="/login" className="sr-auth__link">Sign in</a></div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
