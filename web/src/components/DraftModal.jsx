import { useState } from 'react';
import { api } from '../api.js';
import DraftPreview from './DraftPreview.jsx';

const ACTION_LABELS = {
  'meta-title': 'Meta Title & Description', faq: 'FAQ', schema: 'Schema Markup',
  'internal-links': 'Internal Links', 'blog-outline': 'Blog Outline',
  'landing-page': 'Landing Page', translation: 'Translation', 'llms-txt': 'llms.txt & AI-Crawler Robots.txt',
};

// Must match server/store/drafts.js's MERGE_MANDATORY_TYPES — every
// generator type now has a real, working merge-to-stage strategy, so a real
// merge into stage is the only path to 'implemented' (the backend enforces
// this; this list just keeps the now-invalid "Mark Implemented manually"
// button from being offered in the first place).
const MERGE_MANDATORY_TYPES = ['meta-title', 'faq', 'llms-txt', 'schema', 'internal-links', 'landing-page', 'blog-outline', 'translation'];

// Status progression: draft/edited -> submitted_for_approval -> approved ->
// branch_pushed -> merged_to_stage -> implemented. "Push Branch" is its own
// real, reviewable step (a real branch with the real change exists at
// branch_pushed — Draft Preview panel below) before anyone decides to merge
// it into `stage` (which auto-deploys — no PR needed there, see
// ~/Travel/ci-cd-deployment-master-guide). "Merge to Stage" then
// auto-completes straight through to 'implemented' in the same action —
// a real merge into stage is the only real evidence this platform can ever
// have; promoting stage -> main/production stays a fully manual, human
// action outside this app entirely, done separately on GitHub. `merged_to_
// stage` itself is rarely user-visible — normally passed through instantly.
const STATUS_INFO = {
  draft: { label: 'Draft · never published', color: '#6366f1' },
  edited: { label: 'Edited draft · never published', color: '#6366f1' },
  submitted_for_approval: { label: 'Submitted for approval', color: '#f59e0b' },
  approved: { label: 'Approved · not yet live', color: '#059669' },
  branch_pushed: { label: 'Branch pushed · review before merge', color: '#7c3aed' },
  merged_to_stage: { label: 'Merged to stage', color: '#2563eb' },
  implemented: { label: 'Implemented · live on stage', color: '#16a34a' },
};

// The real diff — computed server-side by the exact same function that
// would actually write the file (server/implementers/backend.js), never a
// client-side guess at what the change would look like. `changedRegions`
// (meta-title/faq) shows just the spliced marker region per field; llms-txt
// has no regions (its whole file is the change) so falls back to a
// full-file before/after.
function FileDiffPreview({ result }) {
  const regions = result.changedRegions?.length
    ? result.changedRegions
    : [{ field: result.filePath, before: result.oldContent, after: result.newContent }];
  return (
    <div className="mt-3 space-y-3 fade-up">
      <p className="text-[11px] text-slate-400">Real diff for <code className="font-mono">{result.filePath}</code> — fetched live from GitHub.</p>
      {regions.map((r, i) => (
        <div key={i} className="space-y-1.5">
          {r.field && r.field !== result.filePath && <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{r.field}</p>}
          <div className="rounded-lg border border-rose-100 bg-rose-50/60 px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-rose-500 mb-1">− Current</p>
            <pre className="text-xs whitespace-pre-wrap text-rose-900 max-h-40 overflow-y-auto">{r.before || '(empty)'}</pre>
          </div>
          <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-600 mb-1">+ After this draft</p>
            <pre className="text-xs whitespace-pre-wrap text-emerald-900 max-h-40 overflow-y-auto">{r.after}</pre>
          </div>
        </div>
      ))}
    </div>
  );
}

// Preview / Copy / Edit / Save Draft, plus the approval lifecycle, for one draft.
export default function DraftModal({ draft, onClose, onSaved, onDeleted }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(draft.content, null, 2));
  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [copyLabel, setCopyLabel] = useState('Copy');
  const [error, setError] = useState(null);
  const [filePreview, setFilePreview] = useState(null); // null | 'loading' | {ok, ...} | {ok:false, error}
  const status = STATUS_INFO[draft.status] || STATUS_INFO.draft;

  const selectTitle = async (title) => {
    try {
      const updated = await api.actionCenter.saveDraft(draft.id, { ...draft.content, selectedTitle: title });
      onSaved(updated);
    } catch (e) {
      setError(e.message || 'Could not select title');
    }
  };

  const loadFilePreview = async () => {
    setFilePreview('loading');
    try {
      const result = await api.actionCenter.previewDraft(draft.id);
      setFilePreview(result);
    } catch (e) {
      setFilePreview({ ok: false, error: e.message || 'Preview failed' });
    }
  };

  const transition = async (action) => {
    setTransitioning(true);
    setError(null);
    try {
      const updated = await action();
      onSaved(updated);
    } catch (e) {
      setError(e.message || 'Action failed');
    } finally {
      setTransitioning(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(draft.content, null, 2));
      setCopyLabel('Copied ✓');
      setTimeout(() => setCopyLabel('Copy'), 1500);
    } catch {
      setCopyLabel('Copy failed');
      setTimeout(() => setCopyLabel('Copy'), 1500);
    }
  };

  const startEdit = () => { setText(JSON.stringify(draft.content, null, 2)); setError(null); setEditing(true); };

  const save = async () => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('Not valid JSON — fix formatting before saving.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.actionCenter.saveDraft(draft.id, parsed);
      setEditing(false);
      onSaved(updated);
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm('Discard this draft? This cannot be undone.')) return;
    try {
      await api.actionCenter.deleteDraft(draft.id);
      onDeleted(draft.id);
    } catch (e) {
      setError(e.message || 'Delete failed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-500">{ACTION_LABELS[draft.action_type] || draft.action_type}</div>
            <div className="text-sm font-bold mt-0.5" style={{ color: status.color }}>{status.label}</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        {draft.apply_error && (
          <div className="px-5 py-2.5 border-b border-slate-100 bg-rose-50/60 text-xs text-rose-700 leading-relaxed">
            <span className="font-semibold">Last attempt failed:</span> {draft.apply_error}
          </div>
        )}

        {draft.stage_merge_url && (
          <div className="px-5 py-2.5 border-b border-slate-100 bg-blue-50/50 flex items-center justify-between gap-2 text-xs">
            <a href={draft.stage_merge_url} target="_blank" rel="noopener noreferrer" className="font-semibold text-blue-600 hover:underline">
              View merge commit on GitHub →
            </a>
            <span className="font-semibold text-blue-600">Merged to stage</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {editing ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full h-96 text-xs font-mono border border-slate-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              spellCheck={false}
            />
          ) : (
            <>
              <DraftPreview actionType={draft.action_type} content={draft.content}
                onSelectTitle={draft.action_type === 'meta-title' && draft.status !== 'implemented' ? selectTitle : undefined} />
              {draft.status !== 'implemented' && (
                <div className="mt-4 pt-4 border-t border-slate-100">
                  {draft.status === 'branch_pushed' && (
                    <p className="text-[11px] text-violet-700 bg-violet-50 border border-violet-100 rounded-lg px-3 py-2 mb-2.5 leading-relaxed">
                      This branch is real and already pushed to GitHub — review the real diff below. Merging deploys it to stage and marks this draft implemented, in one step — promoting stage → production stays something you do yourself, separately, on GitHub.
                    </p>
                  )}
                  {!filePreview && (
                    <button type="button" onClick={loadFilePreview}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg text-slate-600 hover:bg-slate-100 border border-slate-200">
                      Show real file preview →
                    </button>
                  )}
                  {filePreview === 'loading' && <p className="text-xs text-slate-400">Fetching the real file from GitHub…</p>}
                  {filePreview && filePreview !== 'loading' && (
                    filePreview.ok ? <FileDiffPreview result={filePreview} /> : (
                      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 leading-relaxed">{filePreview.error}</p>
                    )
                  )}
                </div>
              )}
            </>
          )}
          {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
          {draft.status !== 'implemented' ? (
            <button onClick={remove} className="text-xs font-semibold text-rose-500 hover:text-rose-700">Discard</button>
          ) : <span />}
          <div className="flex items-center gap-2">
            {editing ? (
              <>
                <button onClick={() => setEditing(false)} className="text-xs font-semibold px-3 py-1.5 rounded-lg text-slate-500 hover:bg-slate-100">Cancel</button>
                <button onClick={save} disabled={saving}
                  className="text-xs font-semibold px-3.5 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60">
                  {saving ? 'Saving…' : 'Save Draft'}
                </button>
              </>
            ) : (
              <>
                <button onClick={copy} className="text-xs font-semibold px-3 py-1.5 rounded-lg text-slate-600 hover:bg-slate-100 border border-slate-200">{copyLabel}</button>
                {(draft.status === 'draft' || draft.status === 'edited') && (
                  <>
                    <button onClick={startEdit} className="text-xs font-semibold px-3.5 py-1.5 rounded-lg text-indigo-600 hover:bg-indigo-50 border border-indigo-200">Edit</button>
                    <button onClick={() => transition(() => api.actionCenter.submitDraft(draft.id))} disabled={transitioning}
                      className="text-xs font-semibold px-3.5 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60">
                      {transitioning ? 'Submitting…' : 'Submit for Approval'}
                    </button>
                  </>
                )}
                {draft.status === 'submitted_for_approval' && (
                  <button onClick={() => transition(() => api.actionCenter.approveDraft(draft.id))} disabled={transitioning}
                    className="text-xs font-semibold px-3.5 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60">
                    {transitioning ? 'Approving…' : 'Approve'}
                  </button>
                )}
                {draft.status === 'approved' && (
                  <>
                    {/* Only offered for types with no real merge strategy yet
                        — currently none (all 8 are merge-mandatory), kept as
                        a defensive fallback; the backend rejects this call
                        for any merge-mandatory type even if somehow
                        triggered. */}
                    {!MERGE_MANDATORY_TYPES.includes(draft.action_type) && (
                      <button onClick={() => transition(() => api.actionCenter.implementDraft(draft.id))} disabled={transitioning}
                        className="text-xs font-semibold px-3.5 py-1.5 rounded-lg text-slate-500 hover:bg-slate-100 border border-slate-200 disabled:opacity-60">
                        Mark Implemented manually
                      </button>
                    )}
                    <button onClick={() => transition(() => api.actionCenter.pushBranch(draft.id))} disabled={transitioning}
                      className="text-xs font-semibold px-3.5 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60">
                      {transitioning ? 'Pushing…' : 'Push Branch'}
                    </button>
                  </>
                )}
                {draft.status === 'branch_pushed' && (
                  <>
                    <span className="text-[11px] text-slate-400 font-mono truncate max-w-[220px]" title={draft.branch_name}>
                      {draft.branch_name}
                    </span>
                    <button onClick={() => transition(() => api.actionCenter.mergeToStage(draft.id))} disabled={transitioning}
                      className="text-xs font-semibold px-3.5 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60">
                      {transitioning ? 'Merging & marking implemented…' : 'Merge to Stage'}
                    </button>
                  </>
                )}
                {/* Normally never seen — Merge to Stage above auto-completes
                    straight to 'implemented'. Real fallback only, for the
                    rare case that auto-completion didn't fire. */}
                {draft.status === 'merged_to_stage' && (
                  <>
                    <span className="text-[11px] text-slate-400 max-w-[260px] leading-snug">
                      Live on staging.
                    </span>
                    <button onClick={() => transition(() => api.actionCenter.implementDraft(draft.id))} disabled={transitioning}
                      className="text-xs font-semibold px-3.5 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 shrink-0">
                      {transitioning ? 'Saving…' : 'Mark Implemented'}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
