import { useEffect, useRef, useState } from 'react';
import { ShieldAlert, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import Drawer from '../Drawer.jsx';
import Button from '../Button.jsx';
import Field from '../Field.jsx';
import { AccessBadge, shortDate } from '../platform/ListParts.jsx';

// SuperRank staff only (Account settings -> Platform, the project's three-dot menu -> Controls). The per-project controls:
// access (client, trial, ended), suspend / reactivate, the autonomous-fixes switch, the analytics IDs the install generator
// writes, and delete. Each control saves the moment it is used, the way it always has; every call is platform_admin on the server too.

const Card = ({ title, tone, children, ...rest }) => (
  <section className="rounded-card bg-white overflow-hidden" style={{ boxShadow: `0 0 0 1px ${tone === 'danger' ? '#f5c6c2' : 'var(--border-2)'}` }} {...rest}>
    <h3 className="px-4 py-2.5 text-[13px] font-semibold border-b" style={tone === 'danger' ? { background: '#fff5f4', color: '#b42318', borderColor: '#f5c6c2' } : { background: '#fafaf9', color: 'var(--fg)', borderColor: 'var(--border)' }}>{title}</h3>
    <div className="px-4 py-3.5 space-y-3">{children}</div>
  </section>
);

const Toggle = ({ options, value, onChange, disabledKeys = [], label }) => (
  <div className="toggle" role="group" aria-label={label}>
    {options.map((o) => (
      <button key={o.value} type="button" aria-pressed={o.value === value} className={o.value === value ? 'is-on' : undefined}
        disabled={disabledKeys.includes(o.value) && o.value !== value} title={o.title} onClick={() => onChange(o.value)}
        style={disabledKeys.includes(o.value) && o.value !== value ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}>{o.label}</button>
    ))}
  </div>
);

// What each access state means, in words, and which changes the server allows from it.
const STATE_TEXT = {
  client: ['Real client', 'No end date. Nothing is disconnected.'],
  demo: ['Trial', (a) => (a.endsAt ? `Full access until ${shortDate(a.endsAt)}.` : 'Full access for a limited time.')],
  ended: ['Trial ended', 'Google and GitHub were disconnected. The owner sees the Overview only.'],
  pending: ['Waiting for approval', 'The owner asked for access. They see the Overview only.'],
  new: ['New', 'Made on Get started; the owner has not asked for access yet.'],
  rejected: ['Declined', 'Access was turned down. The owner sees the Overview only.'],
};
const ACCESS_CHOICES = {
  client: { label: 'Make it a real client', say: 'Gives full access with no end date. We email the owner.', run: (id) => api.clients.access.makeClient(id), done: 'Now a real client.' },
  trial: { label: 'Start a 15-day trial', say: 'Gives full access for 15 days from today. We email the owner.', run: (id) => api.clients.access.approve(id, { type: 'demo' }), done: 'Trial started.' },
  renew: { label: 'Renew the trial', say: 'Another full 15 days from today. We email the owner.', run: (id) => api.clients.access.renew(id), done: 'Trial renewed.' },
  ended: { label: 'End the trial now', say: 'Stops access now and disconnects Google, GitHub and API tokens. This cannot be undone from here.', run: (id) => api.clients.access.end(id), done: 'Trial ended.' },
};

export default function StaffProjectControls({ project, isOpen, onClose, onChanged, section }) {
  const [row, setRow] = useState(null);
  const [auto, setAuto] = useState(false);
  const [limit, setLimit] = useState(60);
  const [ga4, setGa4] = useState('');
  const [pixel, setPixel] = useState('');
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState('');
  const [choice, setChoice] = useState(null); // an access change waiting for "Confirm"
  const danger = useRef(null);

  useEffect(() => {
    if (!isOpen || !project) return;
    setRow(null); setError(null); setNote(null); setConfirmDelete(''); setChoice(null);
    api.clients.list().then((all) => {
      const r = all.find((c) => c.id === project.id);
      setRow(r || null);
      setAuto(!!r?.autoRemediationEnabled); setLimit(r?.autoRemediationDailyLimit ?? 60);
      setGa4(r?.ga4MeasurementId || ''); setPixel(r?.facebookPixelId || '');
    }).catch((e) => setError(e.message || 'Could not load this project.'));
  }, [isOpen, project?.id]);

  useEffect(() => { if (row && section === 'danger') danger.current?.scrollIntoView({ block: 'center' }); }, [row, section]);

  const run = async (key, fn, done) => {
    setBusy(key); setError(null); setNote(null);
    try { const out = await fn(); setNote(typeof done === 'function' ? done(out) : done); await onChanged?.(); } catch (e) { setError(e.message || 'That did not work.'); } finally { setBusy(null); }
  };
  const status = row?.status || 'active';
  const access = project?.access || { state: 'client' };
  const [stateTitle, stateHint] = STATE_TEXT[access.state] || STATE_TEXT.client;
  // Client is never turned back into a trial; only a running trial can be ended; a client cannot be made client again.
  const disabled = [...(access.state === 'client' ? ['client', 'trial'] : []), ...(access.state !== 'demo' ? ['ended'] : [])];
  const current = access.state === 'client' ? 'client' : access.state === 'demo' ? 'trial' : access.state === 'ended' ? 'ended' : null;
  const pick = (v) => setChoice(v === 'trial' && access.state === 'demo' ? 'renew' : v);
  const confirmAccess = () => {
    const c = ACCESS_CHOICES[choice];
    setChoice(null);
    run('access', () => c.run(project.id), (out) => `${c.done}${out && 'emailed' in out ? (out.emailed ? ' The owner was emailed.' : ' The owner could not be emailed.') : ''}`);
  };

  return (
    <Drawer isOpen={isOpen} onClose={onClose} icon={ShieldAlert} title="Staff controls" maxWidth="max-w-[480px]"
      subtitle={project ? `${project.name}${project.domain ? ` · ${project.domain}` : ''}` : ''}>
      <div className="-m-1 space-y-3.5">
        {error && <p className="text-[13px]" style={{ color: '#b42318' }} role="alert">{error}</p>}
        {note && <p className="text-[13px] text-text rounded-control bg-muted px-3 py-2" role="status">{note}</p>}
        {!row && !error && <div className="h-24 bg-muted rounded-card animate-pulse" />}
        {row && (
          <>
            <Card title="Access">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="text-[13px] font-medium text-fg">{stateTitle}</div><div className="text-xs text-faint mt-0.5">{typeof stateHint === 'function' ? stateHint(access) : stateHint}</div></div>
                <AccessBadge access={access} />
              </div>
              <div className="border-t border-border pt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 basis-[170px] flex-1"><div className="text-[13px] font-medium text-fg">Change access</div><div className="text-xs text-faint mt-0.5">Switch this project to a 15-day trial, or end it.</div></div>
                <Toggle label="Change access" value={current} onChange={pick} disabledKeys={disabled}
                  options={[{ value: 'client', label: 'Client', title: access.state === 'client' ? 'Already a real client' : undefined }, { value: 'trial', label: 'Trial', title: access.state === 'client' ? 'A client is not turned back into a trial' : undefined }, { value: 'ended', label: 'Ended', title: access.state !== 'demo' ? 'Only a running trial can be ended' : undefined }]} />
              </div>
              {choice && (
                <div className="rounded-control px-3 py-2.5 text-[13px]" style={{ background: '#fff8ef', boxShadow: 'inset 0 0 0 1px #f6e2bf' }} role="alertdialog" aria-label="Confirm the access change">
                  <b className="font-medium text-fg">{ACCESS_CHOICES[choice].label}?</b> <span className="text-text">{ACCESS_CHOICES[choice].say}</span>
                  <div className="mt-2 flex gap-2"><Button variant="primary" size="sm" disabled={busy === 'access'} onClick={confirmAccess}>Confirm</Button><Button variant="light" size="sm" onClick={() => setChoice(null)}>Cancel</Button></div>
                </div>
              )}
            </Card>

            <Card title="Status">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 basis-[170px] flex-1"><div className="text-[13px] font-medium text-fg">Project is {status === 'active' ? 'active' : status === 'suspended' ? 'suspended' : 'deleted'}</div>
                  <div className="text-xs text-faint mt-0.5">Suspending stops the agent and its jobs. Nothing is deleted. You can switch it back on.</div></div>
                {status !== 'soft_deleted' && (
                  <Toggle label="Status" value={status === 'active' ? 'active' : 'suspended'} onChange={(v) => {
                    if (busy || (v === 'active') === (status === 'active')) return;
                    if (v === 'suspended') run('sus', () => api.clients.suspend(row.id).then(() => setRow((r) => ({ ...r, status: 'suspended' }))), 'Suspended. Its jobs stop; nothing is deleted.');
                    else run('rea', () => api.clients.reactivate(row.id).then(() => setRow((r) => ({ ...r, status: 'active' }))), 'Reactivated.');
                  }} options={[{ value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }]} />
                )}
                {status === 'soft_deleted' && <Button variant="light" size="sm" disabled={busy === 'rea'} onClick={() => run('rea', () => api.clients.reactivate(row.id).then(() => setRow((r) => ({ ...r, status: 'active' }))), 'Reactivated.')}>Reactivate</Button>}
              </div>
            </Card>

            <Card title="Autonomous fixes">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="text-[13px] font-medium text-fg">Let the agent open fix pull requests</div><div className="text-xs text-faint mt-0.5">Off means it only reports. Save to apply.</div></div>
                <button type="button" role="switch" aria-checked={auto} aria-label="Let the agent open fix pull requests" onClick={() => setAuto((v) => !v)}
                  className="relative w-9 h-5 rounded-full shrink-0 mt-0.5 transition-colors" style={{ background: auto ? 'var(--primary)' : '#d4d4d4' }}>
                  <span className="absolute top-0.5 size-4 rounded-full bg-white transition-all" style={{ left: auto ? 18 : 2, boxShadow: '0 1px 2px rgba(0,0,0,.25)' }} />
                </button>
              </div>
              <div className="flex items-end gap-2">
                <div className="w-28"><Field label="Daily limit" type="number" min="0" max="100" value={limit} onChange={(e) => setLimit(e.target.value)} /></div>
                <Button variant="light" disabled={busy === 'auto'} onClick={() => run('auto', () => api.clients.setAutoRemediation(row.id, auto, Number(limit)), 'Saved.')}>Save</Button>
              </div>
            </Card>

            <Card title="Analytics IDs">
              <div className="grid sm:grid-cols-2 gap-2">
                <Field label="GA4 Measurement ID" value={ga4} onChange={(e) => setGa4(e.target.value)} placeholder="G-XXXXXXXXXX" />
                <Field label="Meta Pixel ID" value={pixel} onChange={(e) => setPixel(e.target.value)} placeholder="1234567890" />
              </div>
              <Button variant="light" disabled={busy === 'ids'} onClick={() => run('ids', () => api.clients.setAnalyticsIds(row.id, ga4.trim(), pixel.trim()), 'Saved.')}>Save IDs</Button>
            </Card>

            {status !== 'soft_deleted' && (
              <div ref={danger}>
                <Card title="Danger zone" tone="danger">
                  <div className="text-[13px] font-medium text-fg">Delete project</div>
                  <p className="text-xs text-faint -mt-2">Hides it and stops everything. Type its name to confirm.</p>
                  <div className="flex items-end gap-2">
                    <div className="flex-1 min-w-0"><Field label="Project name" value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} placeholder={row.name} /></div>
                    <Button variant="light" disabled={busy === 'del' || confirmDelete.trim() !== row.name}
                      onClick={() => run('del', () => api.clients.softDelete(row.id), 'Deleted.')}><Trash2 size={14} />Delete</Button>
                  </div>
                </Card>
              </div>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
