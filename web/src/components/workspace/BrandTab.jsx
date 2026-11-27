import { useEffect, useRef, useState } from 'react';
import { Building2, FileText, Lightbulb, Store } from 'lucide-react';
import { api, timeAgo } from '../../api.js';
import Button from '../Button.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import { STATUS } from '../../lib/palette.js';

// Project settings → Brand & topics. What the project's own people tell the agents: the topics they want blogs on, brand documents the agents write by,
// and the business profile fields (corrected here, then kept: a confirmed field is never overwritten when the website is read again).
// Each part is for THIS project only. Adding or removing needs a project admin; members can read.
const MAX_CHARS = 50000;
const field = 'w-full rounded-control border border-border px-3 py-2 text-[13px] bg-white';
const WARN = { background: STATUS.warning.tint, color: STATUS.warning.text };
const OK = { background: STATUS.success?.tint, color: STATUS.success?.text };

function About({ siteId, about, maxChars, canEdit, reload }) {
  const [text, setText] = useState(about ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => { setText(about ?? ''); }, [about]);
  const changed = text.trim() !== String(about ?? '').trim();
  async function save() {
    setBusy(true); setMsg(null);
    try { await api.project.brand.saveAbout(siteId, text.trim()); setMsg({ ok: true, text: 'Saved. The agents use this whenever they write for this project.' }); reload(); }
    catch (e) { setMsg({ ok: false, text: e.message || 'Could not save.' }); }
    finally { setBusy(false); }
  }
  const limit = maxChars || 4000;
  return (
    <SettingsCard icon={Building2} title="About the brand" description="What the brand is, in your own words: what you do, who for, how you sound, what makes you different. The agents read this first.">
      <div className="px-4 sm:px-5 py-4 space-y-2">
        <textarea rows={6} value={text} disabled={!canEdit} maxLength={limit} onChange={(e) => setText(e.target.value)} className={field} aria-label="About the brand"
          placeholder="For example: Zennly is booking and payroll software for salons and spas in Nepal. We sound warm and plain, never salesy. Our customers are owners with two to ten branches." />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-fg-muted">{text.length.toLocaleString()} / {limit.toLocaleString()} characters</span>
          {canEdit && <Button variant="primary" size="sm" write disabled={!changed || busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>}
        </div>
        {msg && <div className="rounded-control px-3.5 py-2.5 text-[13px]" style={msg.ok ? OK : WARN}>{msg.text}</div>}
      </div>
    </SettingsCard>
  );
}

const STATUS_WORDS = { pending_review: 'Waiting to be written', accepted: 'Queued for a blog', dismissed: 'Dropped' };

function Topics({ siteId, topics, canEdit, reload }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  async function add() {
    if (!text.trim() || busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.project.brand.addTopic(siteId, text.trim());
      setMsg({ ok: true, text: r.alreadyQueued ? 'That topic is already in the queue.' : r.planned?.notCreated ? 'Saved, but it could not be queued for a blog yet.' : 'Added. It joins the blog queue and is drafted in the next run.' });
      setText(''); reload();
    } catch (e) { setMsg({ ok: false, text: e.message || 'Could not add that topic.' }); }
    finally { setBusy(false); }
  }
  return (
    <SettingsCard icon={Lightbulb} title="Topics you want blogs on" description="Each topic goes into the blog queue for this project and is drafted for you to approve.">
      <div className="px-4 sm:px-5 py-4 space-y-3">
        {canEdit && (
          <div className="flex gap-2">
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="For example: how to choose a salon booking app in Nepal"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} className={field} aria-label="Topic" />
            <Button variant="primary" size="sm" write disabled={!text.trim() || busy} onClick={add}>{busy ? 'Adding…' : 'Add topic'}</Button>
          </div>
        )}
        {msg && <div className="rounded-control px-3.5 py-2.5 text-[13px]" style={msg.ok ? OK : WARN}>{msg.text}</div>}
        {topics === null ? <div className="text-[13px] text-fg-muted">Loading…</div>
          : topics.length === 0 ? <div className="text-[13px] text-fg-muted">No topics added yet.</div>
            : <ul className="divide-y divide-border">{topics.map((t) => (
              <li key={t.id} className="py-2 flex items-start justify-between gap-3 text-[13px]">
                <span className="text-fg">{t.topic}</span>
                <span className="text-fg-muted shrink-0">{STATUS_WORDS[t.status] || t.status}{t.content_plan === 'blog' ? ' · blog' : ''}</span>
              </li>))}</ul>}
      </div>
    </SettingsCard>
  );
}

function Documents({ siteId, documents, canEdit, reload }) {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  async function pickFile(e) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { setMsg({ ok: false, text: 'That file is over 10 MB. Split it, or paste the part you want read.' }); return; }
    setUploading(true); setMsg(null);
    try {
      const d = await api.project.brand.uploadDocument(siteId, f);
      setMsg({ ok: true, text: `Read “${d.name}” (${(d.chars || 0).toLocaleString()} characters). The agents writing for this project use it from now on.` });
      reload();
    } catch (err) { setMsg({ ok: false, text: err.message || 'That file could not be read.' }); }
    finally { setUploading(false); }
  }
  async function save() {
    if (!name.trim() || !content.trim() || busy) return;
    setBusy(true); setMsg(null);
    try { await api.project.brand.addDocument(siteId, { name: name.trim(), content }); setName(''); setContent(''); setMsg({ ok: true, text: 'Saved. The agents writing for this project use it from now on.' }); reload(); }
    catch (e) { setMsg({ ok: false, text: e.message || 'Could not save the document.' }); }
    finally { setBusy(false); }
  }
  async function remove(id) {
    if (!window.confirm('Remove this document? The agents will stop using it.')) return;
    try { await api.project.brand.deleteDocument(siteId, id); reload(); } catch (e) { setMsg({ ok: false, text: e.message || 'Could not remove it.' }); }
  }
  return (
    <SettingsCard icon={FileText} title="Brand documents" description="Brand guidelines, tone of voice, product facts, what to say and what never to say. Add Word, PDF or text files: the agents read them together with everything on this tab.">
      <div className="px-4 sm:px-5 py-4 space-y-3">
        {canEdit && (
          <div className="space-y-2">
            <div className="flex gap-2 flex-wrap">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Name, for example Tone of voice" className={`${field} sm:max-w-[320px]`} aria-label="Document name" />
              <input ref={fileRef} type="file" accept=".docx,.pdf,.txt,.md,.markdown,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/*" onChange={pickFile} className="hidden" />
            </div>
            <div className="rounded-control border border-dashed border-border px-4 py-4 flex items-center justify-between gap-3 flex-wrap">
              <div className="text-[13px] text-fg-muted">Upload a Word (.docx), PDF or text file. The text is read out of it and the file is not kept.</div>
              <Button variant="primary" size="sm" write disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? 'Reading…' : 'Upload a file'}</Button>
            </div>
            <div className="text-xs text-fg-muted">Or paste the text:</div>
            <textarea rows={7} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Paste the text here, or choose a file above." className={`${field} font-mono`} aria-label="Document text" />
            <div className="flex items-center justify-between gap-3">
              <span className={`text-xs ${content.length > MAX_CHARS ? 'text-danger' : 'text-fg-muted'}`}>{content.length.toLocaleString()} / {MAX_CHARS.toLocaleString()} characters</span>
              <Button variant="primary" size="sm" write disabled={!name.trim() || !content.trim() || content.length > MAX_CHARS || busy} onClick={save}>{busy ? 'Saving…' : 'Save document'}</Button>
            </div>
          </div>
        )}
        {msg && <div className="rounded-control px-3.5 py-2.5 text-[13px]" style={msg.ok ? OK : WARN}>{msg.text}</div>}
        {documents === null ? <div className="text-[13px] text-fg-muted">Loading…</div>
          : documents.length === 0 ? <div className="text-[13px] text-fg-muted">No documents yet.</div>
            : <ul className="divide-y divide-border">{documents.map((d) => (
              <li key={d.id} className="py-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="text-[13px] font-medium text-fg">{d.name}</div>
                  <div className="text-xs text-fg-muted">{Math.max(1, Math.round(d.bytes / 1024))} KB · added {timeAgo(d.created_at)}</div>
                  <div className="text-xs text-fg-muted mt-0.5 line-clamp-2 break-words">{d.excerpt}</div></div>
                {canEdit && <Button variant="light" size="sm" onClick={() => remove(d.id)}>Remove</Button>}
              </li>))}</ul>}
      </div>
    </SettingsCard>
  );
}

const asText = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));

function Profile({ siteId, canEdit }) {
  const [view, setView] = useState(null);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = () => api.project.brand.profile(siteId).then((v) => { setView(v); setDraft({}); }).catch(() => setView({ exists: false, groups: [], error: true }));
  useEffect(() => { setView(null); load(); }, [siteId]);
  const dirty = Object.keys(draft);
  async function save() {
    const edits = [];
    for (const g of view.groups) for (const f of g.fields) {
      if (!(f.key in draft)) continue;
      const raw = draft[f.key].trim();
      const value = Array.isArray(f.value) ? raw.split(',').map((x) => x.trim()).filter(Boolean) : raw;
      if (!raw) edits.push({ field: f.key, accept: false }); else edits.push({ field: f.key, accept: true, value });
    }
    setBusy(true); setMsg(null);
    try { await api.project.brand.reviewProfile(siteId, edits); setMsg({ ok: true, text: 'Saved. These are now confirmed and are not overwritten when your website is read again.' }); await load(); }
    catch (e) { setMsg({ ok: false, text: e.message || 'Could not save.' }); }
    finally { setBusy(false); }
  }
  async function readSite() {
    setBusy(true); setMsg(null);
    try { await api.project.brand.refreshProfile(siteId); await load(); } catch (e) { setMsg({ ok: false, text: e.message || 'Could not read the website.' }); }
    finally { setBusy(false); }
  }
  return (
    <SettingsCard icon={Store} title="About your business" description="What the agents believe about you. Correct anything: what you confirm here is kept.">
      <div className="px-4 sm:px-5 py-4 space-y-4">
        {view === null && <div className="text-[13px] text-fg-muted">Loading…</div>}
        {view && !view.exists && (
          <div className="space-y-2"><div className="text-[13px] text-fg-muted">{view.error ? 'The profile could not be loaded.' : 'No profile yet. Read your website to start one, then correct it here.'}</div>
            {canEdit && !view.error && <Button variant="light" size="sm" onClick={readSite} disabled={busy}>{busy ? 'Reading…' : 'Read my website'}</Button>}</div>
        )}
        {view?.exists && view.groups.map((g) => (
          <div key={g.key} className="space-y-2">
            <div><div className="text-[13px] font-medium text-fg">{g.label}</div>{g.hint && <div className="text-xs text-fg-muted">{g.hint}</div>}</div>
            {g.fields.map((f) => (
              <label key={f.key} className="block">
                <span className="text-xs text-fg-muted">{f.label}{f.status === 'confirmed' ? ' · confirmed' : f.status === 'detected' ? ' · detected from your site' : f.status === 'assumed' ? ' · assumed' : ''}</span>
                <textarea rows={Array.isArray(f.value) || String(f.value || '').length > 90 ? 3 : 2} disabled={!canEdit}
                  value={f.key in draft ? draft[f.key] : asText(f.value)} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  placeholder={Array.isArray(f.value) ? 'Separate items with commas' : 'Not known yet'} className={field} />
              </label>
            ))}
          </div>
        ))}
        {msg && <div className="rounded-control px-3.5 py-2.5 text-[13px]" style={msg.ok ? OK : WARN}>{msg.text}</div>}
        {view?.exists && canEdit && (
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" write disabled={!dirty.length || busy} onClick={save}>{busy ? 'Saving…' : `Save ${dirty.length || ''} change${dirty.length === 1 ? '' : 's'}`.replace('Save  ', 'Save ')}</Button>
            <Button variant="light" size="sm" onClick={readSite} disabled={busy}>Read my website again</Button>
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

export default function BrandTab({ project, manage }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const load = () => api.project.brand.get(project.id).then((d) => { setData(d); setLoadError(null); })
    .catch((e) => { setLoadError(e.message || 'Could not load this tab.'); setData((d) => d || { documents: [], topics: [], about: '', canEdit: manage }); });
  useEffect(() => { setData(null); setLoadError(null); load(); }, [project.id]);
  const canEdit = manage && data?.canEdit !== false;
  return (
    <div className="space-y-5">
      {loadError && <div className="rounded-control px-3.5 py-3 text-[13px]" style={WARN}>This tab could not be loaded: {loadError}. What you add may not save until that is fixed.</div>}
      <About siteId={project.id} about={data ? data.about : ''} maxChars={data?.maxAboutChars} canEdit={canEdit && !!data} reload={load} />
      <Topics siteId={project.id} topics={data ? data.topics : null} canEdit={canEdit} reload={load} />
      <Documents siteId={project.id} documents={data ? data.documents : null} canEdit={canEdit} reload={load} />
      <Profile siteId={project.id} canEdit={canEdit} />
    </div>
  );
}
