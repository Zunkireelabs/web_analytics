import { Lock, PartyPopper, Hourglass, Info } from 'lucide-react';
import { CONTACT_URL } from '../../lib/access.jsx';

const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : '');

// One line at the top of the page that says where the project stands in the free-trial flow (server/store/access.js).
// Nothing for a client, or for a project that was never part of it.
export default function AccessBanner({ access }) {
  if (!access || access.state === 'client' || !access.state) return null;
  const link = <a href={CONTACT_URL} target="_blank" rel="noreferrer" className="font-medium text-fg underline underline-offset-2">Contact us</a>;
  let tone = 'bg-primary-tint', Icon = Hourglass, text = null;
  if (access.state === 'pending') {
    text = access.requested
      ? <><b className="font-semibold text-fg">Your request is with the SuperRank team.</b> We email you as soon as you are approved. Until then the Overview is open and the rest is locked. {link} if you would like to talk first.</>
      : <><b className="font-semibold text-fg">Your dashboard is ready, and your setup is saved.</b> {link} to start your free trial and unlock the rest.</>;
  } else if (access.state === 'demo') {
    tone = 'bg-green-tint'; Icon = PartyPopper;
    const left = access.daysLeft;
    text = <><b className="font-semibold text-fg">You are on a 15-day demo{left != null ? `: ${left} day${left === 1 ? '' : 's'} left` : ''}</b>{access.endsAt ? `, until ${fmt(access.endsAt)}` : ''}. Everything is unlocked. Connect Google and GitHub if you like, or skip them. Want to keep going after? {link}.</>;
  } else if (access.state === 'ended') {
    tone = 'bg-[#fdecec]'; Icon = Lock;
    text = <><b className="font-semibold text-fg">Your demo ended{access.endedAt || access.endsAt ? ` on ${fmt(access.endedAt || access.endsAt)}` : ''}.</b> Your Overview is kept as it was. Google, Analytics and GitHub were disconnected, and the other pages are locked. {link} to continue.</>;
  } else if (access.state === 'rejected') {
    tone = 'bg-muted'; Icon = Info;
    text = <><b className="font-semibold text-fg">Your request was not approved.</b> {link} and we will talk it through.</>;
  }
  if (!text) return null;
  return (
    <div role="status" className={`flex items-start gap-3 px-4 md:px-6 py-3 text-[13px] leading-[19px] text-text border-b border-border-canvas ${tone}`}>
      <Icon size={16} className="mt-0.5 shrink-0 text-primary" />
      <div className="min-w-0">{text}</div>
    </div>
  );
}
