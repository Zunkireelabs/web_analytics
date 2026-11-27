import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import Button from '../Button.jsx';
import { STATUS } from '../../lib/palette.js';

// The wording of a draft in plain fields, for any kind of draft (a meta title, an Open Graph card, a FAQ, a blog post...). Change what you want and save: only the text a reader would see
// can change, never the structure, and the change must pass the same checks a new draft passes before it is saved. Nothing goes live until the draft is approved.
export default function DraftFieldsEditor({ draftId, siteId, onSaved }) {
  const [state, setState] = useState(null); // null loading | { editable, fields } | { error }
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [issues, setIssues] = useState(null);
  const [notice, setNotice] = useState(null);
  const [asking, setAsking] = useState(null); // path of the field whose "what should change?" box is open
  const [ask, setAsk] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState(null);

  // What the server last sent for each field, so a reload can tell what the person has typed and not saved yet from what is just the server's own value.
  const served = useRef({});
  const latest = useRef(0);
  // `reset` is the paths whose typing is replaced by the server's value (what was just saved); every other field keeps its unsaved typing.
  const load = (reset = []) => {
    const mine = ++latest.current;
    return api.actionCenter.editFields(draftId, siteId)
      .then((r) => {
        if (mine !== latest.current) return; // another draft was opened meanwhile
        const was = served.current;
        served.current = Object.fromEntries(r.fields.map((f) => [f.path, f.value]));
        setState(r);
        setValues((prev) => Object.fromEntries(r.fields.map((f) => {
          const typed = prev[f.path] !== undefined && String(prev[f.path]) !== String(was[f.path] ?? '');
          return [f.path, typed && !reset.includes(f.path) ? prev[f.path] : f.value];
        })));
      })
      .catch((e) => { if (mine === latest.current) setState({ error: e.message || 'The draft could not be loaded.' }); });
  };
  useEffect(() => { served.current = {}; latest.current += 1; setState(null); setValues({}); setNotice(null); setError(null); setAsking(null); load(); }, [draftId, siteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = useMemo(() => (state?.fields || []).filter((f) => String(values[f.path] ?? '') !== f.value), [state, values]);

  // "Tell the writer what to change": the Claude worker rewrites just this field as asked; it is checked and saved like typed text, and the new wording shows here.
  async function askWriter(path) {
    setAskBusy(true); setAskError(null); setNotice(null); setError(null); setIssues(null);
    try {
      const r = await api.actionCenter.rewriteField(draftId, { path, instruction: ask }, siteId);
      setNotice('Changed and saved. Nothing goes live until you approve.');
      setAsking(null); setAsk('');
      if (r.draft) onSaved?.(r.draft);
      await load([path]);
    } catch (e) { setAskError(e.message || 'The change could not be made.'); setIssues(e.issues || null); } finally { setAskBusy(false); }
  }

  async function save() {
    setBusy(true); setError(null); setIssues(null); setNotice(null);
    try {
      const edits = Object.fromEntries(changed.map((f) => [f.path, values[f.path]]));
      const r = await api.actionCenter.editContent(draftId, { edits }, siteId);
      setNotice('Saved. Nothing goes live until you approve.');
      if (r.draft) onSaved?.(r.draft);
      await load(changed.map((f) => f.path));
    } catch (e) { setError(e.message || 'The change could not be saved.'); setIssues(e.issues || null); } finally { setBusy(false); }
  }

  if (state === null) return <div className="h-40 rounded-card bg-muted animate-pulse" />;
  if (state.error) return <div className="rounded-control px-3.5 py-3 text-[13px]" style={{ background: STATUS.warning.tint, color: STATUS.warning.text }}>{state.error}</div>;
  if (!state.fields.length) return <div className="rounded-card bg-muted px-5 py-8 text-center text-sm text-text">There is no wording in this draft to edit.</div>;
  return (
    <div className="space-y-4">
      {!state.editable && <div className="rounded-control px-3.5 py-3 text-[13px]" style={{ background: STATUS.warning.tint, color: STATUS.warning.text }}>This draft has already been approved or shipped, so it can no longer be edited here.</div>}
      <p className="text-[13px] text-faint">Change the wording you want and press Save. Only text can be changed here, and every change is checked before it is saved.</p>
      {state.fields.map((f) => (
        <div key={f.path} className="space-y-1">
          <label className="text-xs text-faint" htmlFor={`f-${f.path}`}>{f.label}</label>
          {f.long
            ? <textarea id={`f-${f.path}`} rows={Math.min(10, Math.max(3, Math.ceil(String(values[f.path] || '').length / 70)))} value={values[f.path] ?? ''} disabled={busy || !state.editable} onChange={(e) => setValues((v) => ({ ...v, [f.path]: e.target.value }))} className="w-full rounded-control border border-border px-3 py-2 text-[13px] bg-white" />
            : <input id={`f-${f.path}`} value={values[f.path] ?? ''} disabled={busy || !state.editable} onChange={(e) => setValues((v) => ({ ...v, [f.path]: e.target.value }))} className="w-full rounded-control border border-border px-3 py-2 text-[13px] bg-white" />}
          {state.editable && asking !== f.path && <button type="button" className="text-xs underline text-faint" onClick={() => { setAsking(f.path); setAsk(''); setAskError(null); }}>Tell the writer what to change</button>}
          {state.editable && asking === f.path && (
            <div className="rounded-control border border-border bg-white p-3 space-y-2">
              <div className="text-xs text-faint">What should change in “{f.label}”?</div>
              <textarea rows={2} value={ask} onChange={(e) => setAsk(e.target.value)} disabled={askBusy} placeholder="For example: make it shorter, or friendlier, or mention the free trial" className="w-full rounded-control border border-border px-3 py-2 text-[13px] bg-white" />
              {askError && <div className="text-[13px]" style={{ color: STATUS.warning.text }}>{askError}</div>}
              <div className="flex items-center gap-2">
                <Button variant="primary" write size="sm" onClick={() => askWriter(f.path)} disabled={askBusy || !ask.trim()}>{askBusy ? 'Changing…' : 'Change it'}</Button>
                <Button variant="light" size="sm" onClick={() => setAsking(null)} disabled={askBusy}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      ))}
      {notice && <div className="rounded-control px-3.5 py-2.5 text-[13px]" style={{ background: STATUS.success?.tint, color: STATUS.success?.text }}>{notice}</div>}
      {error && (
        <div className="rounded-control px-3.5 py-3 text-[13px] space-y-1" style={{ background: STATUS.warning.tint, color: STATUS.warning.text }}>
          <div>{error}</div>
          {issues?.length > 0 && <ul className="list-disc pl-5">{issues.map((i, n) => <li key={n}>{i.detail || i.rule}</li>)}</ul>}
        </div>
      )}
      {state.editable && (
        <div className="flex items-center gap-2">
          <Button variant="primary" write onClick={save} disabled={busy || changed.length === 0}>{busy ? 'Saving…' : 'Save changes'}</Button>
          <Button variant="light" onClick={() => setValues(Object.fromEntries(state.fields.map((f) => [f.path, f.value])))} disabled={busy || changed.length === 0}>Undo my changes</Button>
          <span className="text-xs text-faint">{changed.length ? `${changed.length} field${changed.length === 1 ? '' : 's'} changed` : 'No changes yet'}</span>
        </div>
      )}
    </div>
  );
}
