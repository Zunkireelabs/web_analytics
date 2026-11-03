import { useEffect, useMemo, useRef, useState } from 'react';
import { UserCheck } from 'lucide-react';
import { api } from '../../api.js';
import Button from '../Button.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import { SummaryRow, FilterBar, Pager, usePaged } from '../platform/ListKit.jsx';
import { Avatar, StatusPill, Note, LoadingRows, EmptyRow, ErrorRow, HeadRow } from '../platform/RequestsParts.jsx';
import { APPROVAL_FILTERS, approvalRows, approvalCounts, filterApprovals, approvalStatus, ago } from '../../lib/requests-view.js';

const PER_PAGE = 12;
const COLS = 'minmax(0,1.6fr) 190px 130px 180px';

// What staff are told after approving or resending: did the email go, and (laptop only) the link.
const noteFor = (r) => (r.emailSent
  ? { text: `${r.email} is approved. We emailed them a link to confirm their address; their account is created when they do.` }
  : r.devConfirmUrl
    ? { text: `${r.email} is approved. Mail is not set up on this server, so here is their confirmation link to try it:`, link: r.devConfirmUrl }
    : { text: `${r.email} is approved, but the email could not be sent. Use Resend below, or tell them to ask for a new link.` });

// Account settings → Platform: new sign-up requests to approve or reject, and the
// people already approved who have not yet confirmed their email. Platform admins
// only (the endpoints are staff-only too). Approving creates nothing yet: it
// emails a one-time link, and the account is created when the person uses it.
export default function ApprovalRequests() {
  const [requests, setRequests] = useState(null); // null = loading
  const [awaiting, setAwaiting] = useState([]);
  const [reviewState, setReviewState] = useState({}); // {[requestId]: 'approving'|'rejecting'|'error'}
  const [reviewError, setReviewError] = useState({});
  const [note, setNote] = useState(null); // { text, link? }
  const [resending, setResending] = useState(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState('waiting');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('oldest');

  const loadRequests = () => api.clients.signupRequests.list().then(setRequests).catch(() => { setRequests([]); setFailed(true); });
  const loadAwaiting = () => api.clients.signupRequests.awaiting().then(setAwaiting).catch(() => { setAwaiting([]); setFailed(true); });
  const reload = () => { setFailed(false); loadRequests(); loadAwaiting(); };
  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async (request) => {
    setReviewState((s) => ({ ...s, [request.id]: 'approving' }));
    setReviewError((e) => ({ ...e, [request.id]: null }));
    try {
      const approved = await api.clients.signupRequests.approve(request.id);
      setRequests((rs) => (rs || []).filter((r) => r.id !== request.id));
      window.dispatchEvent(new Event('signups:changed')); // the bell's badge drops straight away
      setNote(noteFor(approved));
      loadAwaiting();
    } catch (err) {
      setReviewError((e) => ({ ...e, [request.id]: err.message || 'Approval failed.' }));
      setReviewState((s) => ({ ...s, [request.id]: 'error' }));
    }
  };

  const reject = async (request) => {
    setReviewState((s) => ({ ...s, [request.id]: 'rejecting' }));
    setReviewError((e) => ({ ...e, [request.id]: null }));
    try {
      await api.clients.signupRequests.reject(request.id);
      setRequests((rs) => (rs || []).filter((r) => r.id !== request.id));
      window.dispatchEvent(new Event('signups:changed'));
    } catch (err) {
      setReviewError((e) => ({ ...e, [request.id]: err.message || 'Reject failed.' }));
      setReviewState((s) => ({ ...s, [request.id]: 'error' }));
    }
  };

  const resend = async (r) => {
    setResending(r.id);
    try { setNote(noteFor(await api.clients.signupRequests.resend(r.id))); await loadAwaiting(); }
    catch (err) { setNote({ text: err.message || 'Could not resend.', bad: true }); }
    finally { setResending(null); }
  };

  const all = useMemo(() => approvalRows(requests, awaiting), [requests, awaiting]);
  const counts = useMemo(() => approvalCounts(all), [all]);
  // Once, when the lists first arrive: an empty "Waiting" pill is a dead end, so open on All instead.
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || requests === null) return;
    settled.current = true;
    if (!counts.waiting && counts.all) setFilter('all');
  }, [requests, counts.waiting, counts.all]);
  const list = useMemo(() => filterApprovals(all, { filter, query, sort }), [all, filter, query, sort]);
  const paged = usePaged(list, PER_PAGE, `${filter}|${query}|${sort}`);
  const loading = requests === null;

  return (
    <SettingsCard icon={UserCheck} title="Approval requests"
      description="New sign-ups waiting for your approval, and approved people who have not confirmed their email yet.">
      <Note note={note} onClose={() => setNote(null)} />
      <SummaryRow cols={4} counts={[
        { label: 'Waiting for you', value: counts.waiting, tone: 'warn', onClick: () => setFilter('waiting') },
        { label: 'Email not confirmed yet', value: counts.unconfirmed, onClick: () => setFilter('unconfirmed') },
        { label: 'Link expired', value: counts.expired, onClick: () => setFilter('expired') },
        { label: 'Total', value: counts.all, onClick: () => setFilter('all') },
      ]} />
      <FilterBar query={query} onQuery={setQuery} placeholder="Search company or email"
        filters={APPROVAL_FILTERS.map((f) => ({ ...f, count: counts[f.key] }))} filter={filter} onFilter={setFilter}
        sorts={[{ key: 'oldest', label: 'Oldest first' }, { key: 'newest', label: 'Newest first' }]} sort={sort} onSort={setSort} />
      {loading ? <LoadingRows /> : failed ? <ErrorRow onRetry={reload} /> : list.length === 0 ? (
        <EmptyRow>{query ? 'Nothing matches that search.' : filter === 'waiting' ? 'No requests waiting for approval.' : 'Nothing in this list.'}</EmptyRow>
      ) : (
        <div>
          <HeadRow cols={COLS} labels={['Company', 'Status', 'Asked', '']} />
          {paged.rows.map((r) => {
            const st = approvalStatus(r.status);
            const state = r.kind === 'request' ? reviewState[r.id] : null;
            const busy = state === 'approving' || state === 'rejecting';
            const req = r.kind === 'request' ? requests.find((x) => x.id === r.id) : null;
            const sub = [r.email, r.website].filter(Boolean).join(' \u00b7 ');
            const extra = [r.role, r.heardFrom && `Heard about us: ${r.heardFrom}`].filter(Boolean).join(' \u00b7 ');
            return (
              <div key={r.key} className="grid lg:[grid-template-columns:var(--cols)] items-center gap-x-4 gap-y-2.5 px-4 sm:px-5 py-3 border-t border-border" style={{ '--cols': COLS }}>
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar name={r.company} />
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-medium text-fg truncate">{r.person ? `${r.person} \u00b7 ${r.company}` : r.company}</p>
                    <p className="text-xs text-faint truncate">{sub}</p>
                    {extra && <p className="text-xs text-faint truncate">{extra}</p>}
                    {r.kind === 'request' && reviewError[r.id] && <p className="text-xs text-[#b42318] mt-0.5">{reviewError[r.id]}</p>}
                  </div>
                </div>
                <div><StatusPill tone={st.tone}>{st.text}</StatusPill></div>
                <span className="text-[13px] text-faint">{ago(r.at)}</span>
                <div className="flex items-center gap-2 lg:justify-end">
                  {req ? (
                    <>
                      <Button variant="primary" size="sm" onClick={() => approve(req)} disabled={busy}>{state === 'approving' ? 'Approving\u2026' : 'Approve'}</Button>
                      <Button variant="light" size="sm" onClick={() => reject(req)} disabled={busy}>{state === 'rejecting' ? 'Rejecting\u2026' : 'Reject'}</Button>
                    </>
                  ) : (
                    <Button variant="light" size="sm" onClick={() => resend({ id: r.id })} disabled={resending === r.id}>{resending === r.id ? 'Sending\u2026' : 'Resend email'}</Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!loading && !failed && <Pager total={list.length} page={paged.page} per={PER_PAGE} onPage={paged.setPage} noun="people" />}
    </SettingsCard>
  );
}
