import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import Button from '../Button.jsx';
import Badge from '../Badge.jsx';
import Field from '../Field.jsx';

// What this project offers — the list that research, relevance and competitor work are all grounded in.
//
// The system READS the client's own site and proposes what it finds; nothing it proposes steers a single call or a
// piece of content until a person approves it here. So this screen has one job: make approving fast and safe.
//   - every proposal shows the sentence from the client's own page it came from, so approving is reading, not trusting
//   - the name and sentence are editable at approval, because the machine's wording is a draft
//   - removing a proposal is one click and permanent: the same name is never proposed again
//
// Uses the app's own Field / Button / Badge — no invented classes.

export default function CapabilityReview({ siteId, onChanged }) {
  const [state, setState] = useState(null); // { proposed, verified }
  const [busy, setBusy] = useState(null);   // id being acted on, or 'discover' / 'add'
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [edits, setEdits] = useState({});   // id -> { name, description }
  const [adding, setAdding] = useState('');

  const load = () => api.project.capabilities.list(siteId)
    .then((res) => { setState(res); setError(null); })
    .catch(() => setError('Could not load this list right now.'));

  useEffect(() => { load(); }, [siteId]);

  async function act(fn, id) {
    setBusy(id); setError(null); setNote(null);
    try { await fn(); await load(); onChanged?.(); }
    catch (e) { setError(e?.message || 'That did not work. Try again.'); }
    finally { setBusy(null); }
  }

  const review = (item, decision) => act(
    () => api.project.capabilities.review(siteId, item.id, { decision, ...(edits[item.id] || {}) }), item.id
  );

  async function discover() {
    setBusy('discover'); setError(null); setNote(null);
    try {
      const out = await api.project.capabilities.discover(siteId);
      await load();
      setNote(out.proposed
        ? `Found ${out.proposed} thing${out.proposed === 1 ? '' : 's'} on your site. Review ${out.proposed === 1 ? 'it' : 'them'} below.`
        : discoverReason(out.skipped));
    } catch (e) { setError(e?.message || 'Could not read the site right now.'); }
    finally { setBusy(null); }
  }

  async function add() {
    await act(async () => { await api.project.capabilities.add(siteId, { name: adding }); setAdding(''); }, 'add');
  }

  if (!state) return <div className="px-5 py-4 text-sm text-faint">{error || 'Loading…'}</div>;

  const { proposed, verified } = state;
  const empty = !proposed.length && !verified.length;

  return (
    <div className="px-5 py-4 space-y-4">
      <p className="text-[13px] leading-relaxed">
        What you sell, in your own words. Research and recommendations are built around this list, so it is worth a
        minute to get right.
      </p>

      {error && <div className="rounded-card bg-[#fdecec] border border-[#f3c6c6] text-[#b42318] text-sm px-4 py-3">{error}</div>}
      {note && <div className="rounded-card bg-[#fafafa] border border-line text-[13px] px-4 py-3">{note}</div>}

      {proposed.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium">Found on your site</span>
            <Badge tone="amber">{proposed.length} to review</Badge>
          </div>
          {proposed.map((item) => {
            const edit = edits[item.id] || {};
            return (
              <div key={item.id} className="rounded-card border border-line px-4 py-3 space-y-2">
                <Field
                  label="Name"
                  value={edit.name ?? item.name}
                  onChange={(e) => setEdits((m) => ({ ...m, [item.id]: { ...m[item.id], name: e.target.value } }))}
                  maxLength={80}
                />
                {item.evidence && (
                  <p className="text-xs text-faint leading-relaxed">
                    From your site: <q>{item.evidence}</q>
                  </p>
                )}
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" disabled={busy === item.id} onClick={() => review(item, 'approve')}>
                    {busy === item.id ? 'Saving…' : 'Yes, we offer this'}
                  </Button>
                  <Button variant="light" size="sm" disabled={busy === item.id} onClick={() => review(item, 'reject')}>
                    Not something we sell
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {verified.length > 0 && (
        <div className="space-y-2">
          <div className="text-[13px] font-medium">Confirmed</div>
          <ul className="flex flex-wrap gap-2">
            {verified.map((v) => <li key={v.id}><Badge tone="green">{v.name}</Badge></li>)}
          </ul>
        </div>
      )}

      {empty && (
        <p className="text-[13px] text-faint">
          Nothing listed yet. We can read your website and suggest what you offer, or you can add it yourself.
        </p>
      )}

      <div className="space-y-3 pt-1">
        <div className="flex flex-wrap gap-2">
          <Button variant="light" size="sm" disabled={busy === 'discover'} onClick={discover}>
            {busy === 'discover' ? 'Reading your site…' : (empty ? 'Find what we offer' : 'Look again')}
          </Button>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field
              label="Add one yourself"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              placeholder="e.g. Residential lettings"
              maxLength={80}
            />
          </div>
          <Button variant="light" disabled={busy === 'add' || adding.trim().length < 3} onClick={add}>Add</Button>
        </div>
      </div>
    </div>
  );
}

// Why a discovery run produced nothing, in words — never a bare "0 found" that reads like a failure.
function discoverReason(code) {
  switch (code) {
    case 'nothing_clearly_offered': return 'Your homepage does not clearly say what you sell, so nothing was suggested. Add them yourself below, or add the detail to your site and look again.';
    case 'page_too_thin': return 'Your homepage has too little text to read what you offer from. Add them yourself below.';
    case 'page_unreadable': return 'We could not open your homepage just now. Try again in a moment.';
    case 'no_site_url': return 'This project has no website address set yet.';
    case 'model_unavailable': return 'The reader is unavailable right now. Try again shortly, or add them yourself below.';
    default: return 'Nothing new was found.';
  }
}
