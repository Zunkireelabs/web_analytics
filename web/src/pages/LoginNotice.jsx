import { useEffect, useRef } from 'react';

// The pop-up over the sign-in page when the server will not send a code (server/routes/login.js): each reason
// says what to do next. The server never says whose account it is, so the text only repeats the email just typed.
const ICON = {
  person: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></>,
  pen: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  lock: <><rect width="16" height="10" x="4" y="11" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
};

export const NOTICE_CODES = ['NO_ACCOUNT', 'SETUP_NOT_FINISHED', 'REQUEST_PENDING', 'APPROVAL_NEEDED', 'TRIAL_ENDED'];

// `go` = the button opens a page; otherwise it only closes the pop-up.
const NOTICES = {
  NO_ACCOUNT: {
    icon: 'person', title: 'You are not a member yet', button: 'Sign up free', go: 'signup',
    text: (e) => <><b>{e}</b> is not linked to a SuperRank account. Start your free trial to try it, or ask your team to invite you.</>,
    foot: 'Already a client? Ask your SuperRank contact to confirm your email.',
  },
  SETUP_NOT_FINISHED: {
    icon: 'pen', title: 'Finish your setup', button: 'Continue my setup', go: 'signup',
    text: (e) => <>You started signing up with <b>{e}</b> but did not finish. Your answers are saved, so you carry on where you stopped.</>,
  },
  REQUEST_PENDING: {
    icon: 'clock', title: 'We are reviewing your request', button: 'Got it',
    text: (e) => <>You finished setting up with <b>{e}</b>. A person at SuperRank checks every new account before it opens. We email you a sign-in link as soon as it is approved.</>,
  },
  APPROVAL_NEEDED: {
    icon: 'lock', title: 'Access on hold', button: 'Got it',
    text: (e) => <>We found your account for <b>{e}</b>, but it is no longer linked to a workspace. Our team has been told. Once they confirm you, we email you and you can sign in with a code.</>,
  },
  TRIAL_ENDED: {
    icon: 'clock', title: 'Your free trial has ended', button: 'Contact us', go: 'contact',
    text: (e) => <>Your 15 days for <b>{e}</b> are over, and Google and GitHub were disconnected. Contact us and we will onboard you as a client.</>,
  },
};

export default function LoginNotice({ code, email, siteUrl, contactUrl, onClose, onOtherEmail }) {
  const n = NOTICES[code];
  const card = useRef(null);
  // Focus moves into the pop-up and goes back to where it was when it closes.
  useEffect(() => {
    const before = document.activeElement;
    card.current?.querySelector('.sr-auth__submit')?.focus();
    return () => before?.focus?.();
  }, []);

  const key = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = [...card.current.querySelectorAll('a[href], button')];
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const href = n.go === 'contact' ? contactUrl : n.go === 'signup' ? `${siteUrl}/get-started` : null;
  const arrow = (
    <span className="sr-auth__kbd" aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 3 5 5-5 5" /></svg>
    </span>
  );
  return (
    <div className="sr-pop" onClick={onClose} onKeyDown={key}>
      <div className="sr-pop__card" ref={card} role="dialog" aria-modal="true" aria-labelledby="sr-pop-title" onClick={(e) => e.stopPropagation()}>
        <div className="sr-pop__icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON[n.icon]}</svg>
        </div>
        <h2 id="sr-pop-title">{n.title}</h2>
        <p>{n.text(email)}</p>
        {href
          ? <a className="sr-auth__submit" href={href}><span>{n.button}</span>{arrow}</a>
          : <button type="button" className="sr-auth__submit" onClick={onClose}><span>{n.button}</span>{arrow}</button>}
        <button type="button" className="sr-pop__alt" onClick={onOtherEmail}>Use a different email</button>
        {n.foot && <p className="sr-pop__foot">{n.foot}</p>}
      </div>
    </div>
  );
}
