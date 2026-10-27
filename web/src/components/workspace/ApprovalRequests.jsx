import { useEffect, useState } from 'react';
import { UserCheck } from 'lucide-react';
import { api, timeAgo } from '../../api.js';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';

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

  const loadRequests = () => api.clients.signupRequests.list().then(setRequests).catch(() => setRequests([]));
  const loadAwaiting = () => api.clients.signupRequests.awaiting().then(setAwaiting).catch(() => setAwaiting([]));
  useEffect(() => { loadRequests(); loadAwaiting(); }, []);

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
    catch (err) { setNote({ text: err.message || 'Could not resend.' }); }
    finally { setResending(null); }
  };

  return (
    <SettingsCard icon={UserCheck} title="Approval requests"
      description="New sign-ups waiting for your approval, and approved people who have not confirmed their email yet."
      action={requests && requests.length > 0 ? <Badge tone="primary">{requests.length} pending</Badge> : null}>
      {note && (
        <div className="mx-4 sm:mx-5 mt-3 rounded-control bg-muted px-3 py-2 text-[13px] text-text">
          <p>{note.text}</p>
          {note.link && <a href={note.link} className="mt-1 block break-all text-primary underline underline-offset-2">{note.link}</a>}
        </div>
      )}
      {requests === null ? (
        <p className="px-4 sm:px-5 py-4 text-[13px] text-faint">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="px-4 sm:px-5 py-4 text-[13px] text-faint">No requests waiting for approval.</p>
      ) : requests.map((r) => {
        const state = reviewState[r.id];
        const busy = state === 'approving' || state === 'rejecting';
        return (
          <div key={r.id} className="px-4 sm:px-5 py-3 border-b border-border last:border-0 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-fg truncate">{r.fullName ? `${r.fullName} · ${r.companyName}` : r.companyName}</p>
              <p className="text-xs text-faint truncate">{r.contactEmail} {r.websiteDomain && `· ${r.websiteDomain}`} · requested {timeAgo(r.createdAt)}</p>
              {(r.role || r.heardFrom) && <p className="text-xs text-faint truncate">{[r.role, r.heardFrom && `Heard about us: ${r.heardFrom}`].filter(Boolean).join(' · ')}</p>}
              {reviewError[r.id] && <p className="text-xs text-[#b42318] mt-0.5">{reviewError[r.id]}</p>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="primary" size="sm" onClick={() => approve(r)} disabled={busy}>{state === 'approving' ? 'Approving…' : 'Approve'}</Button>
              <Button variant="light" size="sm" onClick={() => reject(r)} disabled={busy}>{state === 'rejecting' ? 'Rejecting…' : 'Reject'}</Button>
            </div>
          </div>
        );
      })}
      {awaiting.length > 0 && (
        <div className="border-t border-border">
          <p className="px-4 sm:px-5 pt-3 pb-1 text-[11px] font-medium uppercase tracking-[.08em] text-faint">Approved, waiting for email confirmation · {awaiting.length}</p>
          {awaiting.map((r) => (
            <div key={r.id} className="px-4 sm:px-5 py-3 border-b border-border last:border-0 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-fg truncate">{r.companyName}</p>
                <p className="text-xs text-faint truncate">{r.contactEmail} · approved {timeAgo(r.approvedAt)}{r.expired ? ' · link expired' : ''}</p>
              </div>
              <Button variant="light" size="sm" onClick={() => resend(r)} disabled={resending === r.id}>{resending === r.id ? 'Sending…' : 'Resend email'}</Button>
            </div>
          ))}
        </div>
      )}
    </SettingsCard>
  );
}
