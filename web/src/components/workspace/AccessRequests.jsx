import { useEffect, useState } from 'react';
import { Rocket, Check } from 'lucide-react';
import { api, timeAgo } from '../../api.js';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import Modal from '../Modal.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import SignupDetailsModal from './SignupDetailsModal.jsx';

const DEMO_DAYS = 15;
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const endDate = () => fmt(new Date(Date.now() + DEMO_DAYS * 24 * 60 * 60 * 1000));
const CARD = { boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' };
const CARD_ON = { boxShadow: '0 0 0 1px var(--primary), 0 0 0 4px var(--primary-tint)' };

// Account settings → Platform: people who finished /get-started and are waiting for access (server/routes/access.js).
// Approve them as a 15-day demo or as a real client, and look after the demos and clients already approved.
export default function AccessRequests() {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState({});
  const [approving, setApproving] = useState(null);
  const [details, setDetails] = useState(null); // the request whose full Get Started details are open
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  const [returning, setReturning] = useState([]);
  const load = () => { api.clients.access.returning.list().then(setReturning).catch(() => setReturning([])); return api.clients.access.list().then(setRows).catch(() => setRows([])); };
  useEffect(() => { load(); }, []);

  const pending = (rows || []).filter((r) => r.state === 'pending');
  const decided = (rows || []).filter((r) => r.state !== 'pending');

  const run = async (id, fn, text) => {
    setBusy(id);
    try {
      const out = await fn();
      setNote({ text: `${text}${out?.emailed === true ? ' We emailed them.' : out?.emailed === false ? ' The email could not be sent, so let them know yourself.' : ''}` });
      window.dispatchEvent(new Event('signups:changed'));
      await load();
    } catch (e) {
      setNote({ text: e.message || 'That did not work.', bad: true });
    } finally { setBusy(null); }
  };

  return (
    <>
      <SettingsCard icon={Rocket} title="Free-trial requests"
        description="People who finished Get Started and are waiting for access, and the demos and clients you have approved."
        action={pending.length > 0 ? <Badge tone="primary">{pending.length} pending</Badge> : null}>
        {note && (
          <div className={`mx-4 sm:mx-5 mt-3 rounded-control px-3 py-2 text-[13px] ${note.bad ? 'bg-[#fdecec] text-[#b42318]' : 'bg-green-tint text-green'}`} role="status">{note.text}</div>
        )}
        {rows === null ? (
          <p className="px-4 sm:px-5 py-4 text-[13px] text-faint">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="px-4 sm:px-5 py-4 text-[13px] text-faint">No free-trial requests waiting.</p>
        ) : pending.map((r) => (
          <div key={r.siteId} className="px-4 sm:px-5 py-3 border-b border-border last:border-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-fg truncate">{r.owner.name ? `${r.owner.name} · ` : ''}{r.name}</p>
                <p className="text-xs text-faint truncate">{r.owner.email} {r.websiteDomain && `· ${r.websiteDomain}`} · requested {timeAgo(r.requestedAt)}</p>
                <p className="text-xs text-faint truncate">Came through Get Started · email verified</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="primary" size="sm" onClick={() => setApproving(r)} disabled={busy === r.siteId}>Approve</Button>
                <Button variant="light" size="sm" onClick={() => run(r.siteId, () => api.clients.access.reject(r.siteId), `${r.name} was rejected.`)} disabled={busy === r.siteId}>Reject</Button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {r.setup.goals.length > 0 && <Badge>Goals: {r.setup.goals.map((g) => g.toUpperCase()).join(', ')}</Badge>}
              {r.setup.markets.length > 0 && <Badge>Markets: {r.setup.markets.join(', ')}</Badge>}
              <Badge>{r.setup.topics.length} topic{r.setup.topics.length === 1 ? '' : 's'}</Badge>
              <Badge>{r.setup.prompts} prompt{r.setup.prompts === 1 ? '' : 's'}</Badge>
              {r.setup.competitors.length > 0 && <Badge>{r.setup.competitors.length} competitor{r.setup.competitors.length === 1 ? '' : 's'}</Badge>}
              <button type="button" className="text-xs text-primary underline underline-offset-2" onClick={() => setOpen((o) => ({ ...o, [r.siteId]: !o[r.siteId] }))}>{open[r.siteId] ? 'Hide' : 'See what they set up'}</button>
              <button type="button" className="text-xs text-primary underline underline-offset-2" onClick={() => setDetails(r)}>All details</button>
            </div>
            {open[r.siteId] && (
              <div className="mt-2 rounded-control bg-muted px-3 py-2 text-[12.5px] leading-[18px] text-text" style={{ boxShadow: 'inset 0 0 0 1px var(--border)' }}>
                {r.setup.brand && <p><span className="font-medium text-fg">Brand</span> {r.setup.brand}{r.setup.category ? ` · ${r.setup.category}` : ''}</p>}
                {r.setup.topics.length > 0 && <p className="mt-1"><span className="font-medium text-fg">Topics</span> {r.setup.topics.join(', ')}</p>}
                {r.setup.competitors.length > 0 && <p className="mt-1"><span className="font-medium text-fg">Competitors</span> {r.setup.competitors.join(', ')}</p>}
                <p className="mt-1 text-faint">This is what shows on their dashboard once approved.</p>
              </div>
            )}
          </div>
        ))}

        {returning.some((x) => x.status === 'pending') && (
          <div className="border-t border-border">
            <p className="px-4 sm:px-5 pt-3 pb-1 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Returning accounts · {returning.filter((x) => x.status === 'pending').length}</p>
            {returning.filter((x) => x.status === 'pending').map((x) => (
              <div key={x.id} className="px-4 sm:px-5 py-3 border-b border-border last:border-0 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-fg truncate">{x.name ? `${x.name} · ` : ''}{x.email}</p>
                  <p className="text-xs text-faint">{x.reason}</p>
                  <p className="text-xs text-faint">Asked {timeAgo(x.requestedAt)}. No sign-in code has been sent. Approving emails them a new one.</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="primary" size="sm" disabled={busy === `r${x.id}`} onClick={() => run(`r${x.id}`, () => api.clients.access.returning.approve(x.id), `${x.email} is approved to come back.`)}>Approve and send code</Button>
                  <Button variant="light" size="sm" disabled={busy === `r${x.id}`} onClick={() => run(`r${x.id}`, () => api.clients.access.returning.reject(x.id), `${x.email} was not approved.`)}>Reject</Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {decided.length > 0 && (
          <div className="border-t border-border">
            <p className="px-4 sm:px-5 pt-3 pb-1 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Demos and clients · {decided.length}</p>
            {decided.map((r) => (
              <div key={r.siteId} className="px-4 sm:px-5 py-3 border-b border-border last:border-0 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-fg flex items-center gap-2 flex-wrap">
                    {r.name}
                    {r.state === 'client' && <Badge tone="green">Real client</Badge>}
                    {r.state === 'demo' && <Badge tone="amber">Demo · ends {fmt(r.endsAt)}</Badge>}
                    {r.state === 'ended' && <Badge tone="red">Demo ended</Badge>}
                    {r.state === 'rejected' && <Badge>Rejected</Badge>}
                  </p>
                  <p className="text-xs text-faint truncate">{r.owner.email} {r.websiteDomain && `· ${r.websiteDomain}`}{r.state === 'ended' ? ' · Google, Analytics and GitHub were disconnected' : ''}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="light" size="sm" onClick={() => setDetails(r)}>Details</Button>
                  {r.state === 'demo' && <>
                    <Button variant="light" size="sm" disabled={busy === r.siteId} onClick={() => run(r.siteId, () => api.clients.access.makeClient(r.siteId), `${r.name} is now a real client.`)}>Make real client</Button>
                    <Button variant="light" size="sm" disabled={busy === r.siteId} onClick={() => run(r.siteId, () => api.clients.access.end(r.siteId), `${r.name}'s demo ended. Google, Analytics and GitHub were disconnected.`)}>End demo now</Button>
                  </>}
                  {r.state === 'ended' && <>
                    <Button variant="light" size="sm" disabled={busy === r.siteId} onClick={() => run(r.siteId, () => api.clients.access.renew(r.siteId), `${r.name} is renewed for another ${DEMO_DAYS} days.`)}>Renew {DEMO_DAYS} days</Button>
                    <Button variant="primary" size="sm" disabled={busy === r.siteId} onClick={() => run(r.siteId, () => api.clients.access.makeClient(r.siteId), `${r.name} is now a real client.`)}>Make real client</Button>
                  </>}
                  {r.state === 'rejected' && <Button variant="light" size="sm" onClick={() => setApproving(r)}>Approve</Button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>
      {details && <SignupDetailsModal siteId={details.siteId} name={details.name} onClose={() => setDetails(null)} />}
      {approving && <ApproveModal request={approving} onClose={() => setApproving(null)}
        onApprove={(type, githubOptional) => { const r = approving; setApproving(null); run(r.siteId, () => api.clients.access.approve(r.siteId, { type, githubOptional }), type === 'demo' ? `${r.name} is approved for a ${DEMO_DAYS}-day demo, ending ${endDate()}.` : `${r.name} is approved as a real client.`); }} />}
    </>
  );
}

function ApproveModal({ request, onClose, onApprove }) {
  const [type, setType] = useState('demo');
  const [github, setGithub] = useState(true);
  const demo = type === 'demo';
  const pick = (t) => { setType(t); setGithub(t === 'demo'); };
  const Card = ({ id, title, text }) => (
    <button type="button" onClick={() => pick(id)} aria-pressed={type === id} className="text-left rounded-card bg-white px-3.5 py-3" style={type === id ? CARD_ON : CARD}>
      <span className="block text-[13.5px] font-medium text-fg">{title}</span>
      <span className="block mt-0.5 text-xs leading-4 text-faint">{text}</span>
    </button>
  );
  return (
    <Modal isOpen onClose={onClose} icon={Check} title={`Approve ${request.name}`} subtitle={[request.owner.name, request.owner.email].filter(Boolean).join(' · ')} maxWidth="max-w-[560px]" anchor="top"
      footer={<><Button variant="light" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onApprove(type, github)}>{demo ? `Approve ${DEMO_DAYS}-day demo` : 'Approve as real client'}</Button></>}>
      <div className="space-y-4">
        <div>
          <span className="block text-xs font-medium mb-1.5">How should they get access?</span>
          <div className="grid grid-cols-2 gap-2.5">
            <Card id="demo" title="Demo" text={`The full dashboard for ${DEMO_DAYS} days, to try it.`} />
            <Card id="client" title="Real client" text="They are our client. No end date." />
          </div>
        </div>
        <div className="rounded-control bg-muted px-3 py-2.5 text-[12.5px] leading-[18px] text-text" style={{ boxShadow: 'inset 0 0 0 1px var(--border)' }}>
          {demo ? (
            <>
              <b className="font-medium text-fg">{DEMO_DAYS} days, ending {endDate()}.</b> Until then they get the full dashboard. When it ends, automatically:
              <ul className="mt-1 list-disc pl-5">
                <li>Google Search Console, Analytics and GitHub are disconnected, if they connected them, and any API tokens are revoked.</li>
                <li>They keep only their Overview, as it stood.</li>
                <li>Every other page locks. You can renew them or make them a real client from this page.</li>
              </ul>
            </>
          ) : (
            <><b className="font-medium text-fg">{request.owner.email}</b> signs in to the app the usual way, as the owner of <b className="font-medium text-fg">{request.name}</b>. Their sign-up answers are on their dashboard. No end date, and nothing is disconnected. They connect Google and GitHub from the dashboard.</>
          )}
        </div>
        <label className="flex items-start gap-2.5 text-[13px]">
          <input type="checkbox" checked={github} onChange={(e) => setGithub(e.target.checked)} className="mt-[3px]" />
          <span>Let them skip connecting GitHub<span className="block text-xs text-faint">{demo ? 'Recommended for a demo: nothing to disconnect when it ends.' : 'Off by default for clients: the agent needs the repository to prepare fixes.'}</span></span>
        </label>
        <p className="text-xs text-faint">We email {request.owner.email} that they are approved, with a sign-in link.</p>
      </div>
    </Modal>
  );
}
