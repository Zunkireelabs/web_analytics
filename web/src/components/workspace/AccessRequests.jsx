import { useEffect, useMemo, useRef, useState } from 'react';
import { Rocket, Check, Lock } from 'lucide-react';
import { api } from '../../api.js';
import Button from '../Button.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import SignupDetailsModal from './SignupDetailsModal.jsx';
import { SummaryRow, FilterBar, BulkBar, Pager, usePaged } from '../platform/ListKit.jsx';
import RequestsList from '../platform/RequestsList.jsx';
import OnHoldList from '../platform/OnHoldList.jsx';
import { Note, LoadingRows, EmptyRow, ErrorRow } from '../platform/RequestsParts.jsx';
import {
  REQUEST_FILTERS, HOLD_FILTERS, requestCounts, filterRequests, defaultRequestSort, runBulk, holdCounts, filterHold, plural,
} from '../../lib/requests-view.js';

const DEMO_DAYS = 15;
const PER_PAGE = 12;
const HOLD_PER_PAGE = 8;
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const endDate = () => fmt(new Date(Date.now() + DEMO_DAYS * 24 * 60 * 60 * 1000));
const CARD = { boxShadow: '0 0 0 1px var(--input), 0 1px 2px rgba(0,0,0,.03)' };
const CARD_ON = { boxShadow: '0 0 0 1px var(--primary), 0 0 0 4px var(--primary-tint)' };
const approveText = (r, type) => (type === 'demo' ? `${r.name} is approved for a ${DEMO_DAYS}-day free trial, ending ${endDate()}.` : `${r.name} is approved as a real client.`);

// Account settings -> Platform: people who finished /get-started and asked for access (server/routes/access.js).
// Approve them as a 15-day free trial or as a real client, and look after the trials and clients already approved.
// `view` picks which part this draws: 'requests' (the Get-started requests list) or 'hold' (accounts that lost their workspace and asked to
// come back, an approval of its own that lives on the Approvals tab).
export default function AccessRequests({ view = 'requests' }) {
  const hold = view === 'hold';
  const [rows, setRows] = useState(null); // null = loading
  const [failed, setFailed] = useState(false);
  const [returning, setReturning] = useState(null);
  const [approving, setApproving] = useState(null);
  const [details, setDetails] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [filter, setFilter] = useState(hold ? 'pending' : 'waiting');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(null); // null = the default for the filter
  const [selected, setSelected] = useState(() => new Set());

  const load = () => {
    setFailed(false);
    const a = hold ? Promise.resolve() : api.clients.access.list().then(setRows).catch(() => { setRows([]); setFailed(true); });
    const b = hold ? api.clients.access.returning.list().then(setReturning).catch(() => { setReturning([]); setFailed(true); }) : Promise.resolve();
    return Promise.all([a, b]);
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The first time the list arrives, an empty "Waiting" pill is a dead end: open on All instead (once; after that the pill is theirs).
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current) return;
    const data = hold ? returning : rows;
    if (data == null) return;
    settled.current = true;
    const waiting = hold ? data.filter((x) => x.status === 'pending').length : data.filter((x) => x.state === 'pending').length;
    if (!waiting && data.length) setFilter('all');
  }, [rows, returning, hold]);

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

  // ── Requests ──
  const counts = useMemo(() => requestCounts(rows), [rows]);
  const effSort = sort || defaultRequestSort(filter);
  const list = useMemo(() => filterRequests(rows, { filter, query, sort: effSort }), [rows, filter, query, effSort]);
  const paged = usePaged(list, PER_PAGE, `${filter}|${query}|${effSort}`);
  const pickFilter = (k) => { setFilter(k); setSelected(new Set()); setApproving(null); setSort(null); };
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const togglePage = (on) => setSelected((s) => { const n = new Set(s); paged.rows.forEach((r) => (on ? n.add(r.siteId) : n.delete(r.siteId))); return n; });
  const chosen = (rows || []).filter((r) => selected.has(r.siteId) && r.state === 'pending');

  const bulk = async (kind) => {
    const verb = kind === 'reject' ? 'rejected' : 'approved';
    const what = kind === 'demo' ? 'as free trials' : kind === 'client' ? 'as real clients' : '';
    if (!window.confirm(`${kind === 'reject' ? 'Reject' : 'Approve'} ${plural(chosen.length, 'request')} ${what}`.trim() + (kind === 'reject' ? '?' : '? We email each of them.'))) return;
    setBusy('bulk');
    const note = await runBulk(chosen, (r) => (kind === 'reject' ? api.clients.access.reject(r.siteId) : api.clients.access.approve(r.siteId, { type: kind, githubOptional: kind === 'demo' })), verb);
    setNote(note);
    setSelected(new Set());
    window.dispatchEvent(new Event('signups:changed'));
    await load();
    setBusy(null);
  };

  const panel = (r) => (
    <ApprovePanel request={r} onClose={() => setApproving(null)} onApprove={(type, githubOptional) => { setApproving(null); run(r.siteId, () => api.clients.access.approve(r.siteId, { type, githubOptional }), approveText(r, type)); }} />
  );
  const actions = (r, b) => (
    <>
      <Button variant="light" size="sm" onClick={() => setDetails(r)}>Details</Button>
      {(r.state === 'pending' || r.state === 'rejected') && <Button variant="primary" size="sm" disabled={b} onClick={() => setApproving(approving?.siteId === r.siteId ? null : r)}>Approve…</Button>}
      {r.state === 'pending' && <Button variant="light" size="sm" disabled={b} onClick={() => run(r.siteId, () => api.clients.access.reject(r.siteId), `${r.name} was rejected.`)}>Reject</Button>}
      {r.state === 'demo' && <>
        <Button variant="light" size="sm" disabled={b} onClick={() => run(r.siteId, () => api.clients.access.makeClient(r.siteId), `${r.name} is now a real client.`)}>Make real client</Button>
        <Button variant="light" size="sm" disabled={b} onClick={() => run(r.siteId, () => api.clients.access.end(r.siteId), `${r.name}'s trial ended. Google, Analytics and GitHub were disconnected.`)}>End trial</Button>
      </>}
      {r.state === 'ended' && <>
        <Button variant="light" size="sm" disabled={b} onClick={() => run(r.siteId, () => api.clients.access.renew(r.siteId), `${r.name} is renewed for another ${DEMO_DAYS} days.`)}>Renew {DEMO_DAYS} days</Button>
        <Button variant="primary" size="sm" disabled={b} onClick={() => run(r.siteId, () => api.clients.access.makeClient(r.siteId), `${r.name} is now a real client.`)}>Make real client</Button>
      </>}
    </>
  );

  // ── Access on hold ──
  const hc = useMemo(() => holdCounts(returning), [returning]);
  const holdSort = sort || 'newest';
  const holdList = useMemo(() => filterHold(returning, { filter, query, sort: holdSort }), [returning, filter, query, holdSort]);
  const holdPaged = usePaged(holdList, HOLD_PER_PAGE, `${filter}|${query}|${holdSort}`);

  const loading = hold ? returning === null : rows === null;
  const noteEl = <Note note={note} onClose={() => setNote(null)} />;

  if (hold) {
    return (
      <SettingsCard icon={Lock} title="Access on hold" description="Accounts whose workspace was removed and who asked to come back. No sign-in code is sent until you approve."
        action={null}>
        {noteEl}
        <SummaryRow cols={4} counts={[
          { label: 'Waiting', value: hc.pending, tone: 'warn', onClick: () => { setFilter('pending'); } },
          { label: 'Approved, code sent', value: hc.approved, onClick: () => { setFilter('approved'); } },
          { label: 'Projects removed', value: hc.projects }, { label: 'Total requests', value: hc.all, onClick: () => { setFilter('all'); } },
        ]} />
        <FilterBar query={query} onQuery={setQuery} placeholder="Search email or workspace"
          filters={HOLD_FILTERS.map((f) => ({ ...f, count: hc[f.key] }))} filter={filter} onFilter={(k) => { setFilter(k); }}
          sorts={[{ key: 'newest', label: 'Newest first' }, { key: 'oldest', label: 'Oldest first' }]} sort={holdSort} onSort={setSort} />
        {loading ? <LoadingRows n={2} /> : failed ? <ErrorRow onRetry={load} /> : holdList.length === 0 ? (
          <EmptyRow>{query ? 'Nobody matches that search.' : filter === 'pending' ? 'Nobody is waiting to come back.' : 'Nothing here yet.'}</EmptyRow>
        ) : (
          <div className="border-t border-border pt-3.5">
            <OnHoldList rows={holdPaged.rows} busyId={busy}
              onApprove={(x) => run(`r${x.id}`, () => api.clients.access.returning.approve(x.id), `${x.email} is approved to come back.`)}
              onReject={(x) => run(`r${x.id}`, () => api.clients.access.returning.reject(x.id), `${x.email} was not approved.`)} />
          </div>
        )}
        {!loading && !failed && holdList.length > 0 && <Pager total={holdList.length} page={holdPaged.page} per={HOLD_PER_PAGE} onPage={holdPaged.setPage} />}
      </SettingsCard>
    );
  }

  const waitingFilter = filter === 'waiting';
  return (
    <>
      <SettingsCard icon={Rocket} title="Get-started requests" description="People who finished Get Started. Approve them as a 15-day trial or a real client."
        action={null}>
        {noteEl}
        <SummaryRow counts={[
          { label: 'Waiting for you', value: counts.waiting, tone: 'warn', onClick: () => pickFilter('waiting') },
          { label: 'On a trial', value: counts.trials, onClick: () => pickFilter('trials') },
          { label: 'Real clients', value: counts.clients, onClick: () => pickFilter('clients') },
          { label: 'Trials ended', value: counts.ended, onClick: () => pickFilter('ended') },
          { label: 'Rejected', value: counts.rejected, onClick: () => pickFilter('rejected') },
        ]} />
        <FilterBar query={query} onQuery={setQuery} placeholder="Search brand or email"
          filters={REQUEST_FILTERS.map((f) => ({ ...f, count: counts[f.key] }))} filter={filter} onFilter={pickFilter}
          sorts={[{ key: 'newest', label: 'Newest first' }, { key: 'oldest', label: waitingFilter ? 'Oldest waiting first' : 'Oldest first' }]} sort={effSort} onSort={setSort} />
        {waitingFilter && (
          <BulkBar count={chosen.length} onClear={() => setSelected(new Set())}>
            <Button variant="primary" size="sm" disabled={busy === 'bulk'} onClick={() => bulk('demo')}>Approve as free trial</Button>
            <Button variant="light" size="sm" disabled={busy === 'bulk'} onClick={() => bulk('client')}>Approve as real client</Button>
            <Button variant="light" size="sm" disabled={busy === 'bulk'} onClick={() => bulk('reject')}>Reject</Button>
          </BulkBar>
        )}
        {loading ? <LoadingRows /> : failed ? <ErrorRow onRetry={load} /> : list.length === 0 ? (
          <EmptyRow>{query ? 'Nothing matches that search.' : waitingFilter ? 'No requests waiting for you.' : 'Nothing in this list yet.'}</EmptyRow>
        ) : (
          <RequestsList rows={paged.rows} selectable={waitingFilter} selected={selected} onToggle={toggle} onTogglePage={togglePage}
            busy={busy} approvingId={approving?.siteId} renderPanel={panel} actions={actions} />
        )}
        {!loading && !failed && <Pager total={list.length} page={paged.page} per={PER_PAGE} onPage={paged.setPage} noun="requests" />}
      </SettingsCard>
      {details && <SignupDetailsModal request={details}
        onClose={() => setDetails(null)} onApprove={() => { setApproving(details); setDetails(null); }} />}
    </>
  );
}

// The approve choice, inline under the person's row (it used to be a pop-up): a free trial or a real client, what happens next, one button.
function ApprovePanel({ request, onClose, onApprove }) {
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
    <div className="mt-3 rounded-card p-4" style={{ background: '#fcfcfb', boxShadow: 'inset 0 0 0 1px var(--border-2)' }}>
      <h4 className="flex items-center gap-2 text-[13.5px] font-semibold text-fg mb-3"><Check size={14} className="text-faint" />Approve {request.name}</h4>
      <div className="space-y-4">
        <div>
          <span className="block text-xs font-medium mb-1.5">How should they get access?</span>
          <div className="grid grid-cols-2 gap-2.5">
            <Card id="demo" title={`Free trial · ${DEMO_DAYS} days`} text="The full dashboard for 15 days, to try it." />
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
        <div className="flex gap-2 pt-1">
          <Button variant="primary" size="sm" onClick={() => onApprove(type, github)}>{demo ? 'Approve as free trial' : 'Approve as real client'}</Button>
          <Button variant="light" size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
