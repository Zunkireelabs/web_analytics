import { useState } from 'react';
import { api } from '../api.js';
import DraftPreview from './DraftPreview.jsx';
import { 
  FileText, 
  GitBranch, 
  Check, 
  AlertTriangle, 
  Trash2, 
  Copy, 
  Edit3, 
  Sparkles, 
  X, 
  ExternalLink,
  Save,
  Undo,
  ChevronDown,
  ChevronUp
} from 'lucide-react';

const ACTION_LABELS = {
  'meta-title': 'Meta Title & Description', faq: 'FAQ', schema: 'Schema Markup',
  'internal-links': 'Internal Links', 'blog-outline': 'Blog Outline',
  'landing-page': 'Landing Page', translation: 'Translation', 'llms-txt': 'llms.txt & AI-Crawler Robots.txt',
};

const GENERATOR_COLORS = {
  'meta-title': '#6C63FF',
  faq: '#0ea5e9',
  schema: '#8b5cf6',
  'internal-links': '#14b8a6',
  'blog-outline': '#ec4899',
  'landing-page': '#c2410c',
  translation: '#06b6d4',
  'llms-txt': '#10b981',
};

const MERGE_MANDATORY_TYPES = ['meta-title', 'faq', 'llms-txt', 'schema', 'internal-links', 'landing-page', 'blog-outline', 'translation'];

const STATUS_INFO = {
  draft: { label: 'Draft · never published', color: '#6366f1', bg: '#6366f10c', border: '#6366f120' },
  edited: { label: 'Edited draft · never published', color: '#f59e0b', bg: '#f59e0b0c', border: '#f59e0b20' },
  submitted_for_approval: { label: 'Submitted for approval', color: '#f59e0b', bg: '#f59e0b0c', border: '#f59e0b20' },
  approved: { label: 'Approved · not yet live', color: '#059669', bg: '#0596690c', border: '#05966920' },
  branch_pushed: { label: 'Branch pushed · review before merge', color: '#7c3aed', bg: '#7c3aed0c', border: '#7c3aed20' },
  merged_to_stage: { label: 'Merged to stage', color: '#2563eb', bg: '#2563eb0c', border: '#2563eb20' },
  implemented: { label: 'Implemented · live on stage', color: '#16a34a', bg: '#16a34a0c', border: '#16a34a20' },
};

function FileDiffPreview({ result }) {
  const regions = result.changedRegions?.length
    ? result.changedRegions
    : [{ field: result.filePath, before: result.oldContent, after: result.newContent }];
  return (
    <div className="mt-4 space-y-4 animate-slide-down">
      <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-extrabold uppercase tracking-wide">
        <GitBranch size={12} />
        <span>Target:</span>
        <code className="font-mono text-slate-600 bg-slate-100 rounded px-1.5 py-0.5">{result.filePath}</code>
      </div>
      {regions.map((r, i) => (
        <div key={i} className="space-y-2 border border-slate-100 rounded-2xl overflow-hidden">
          {r.field && r.field !== result.filePath && (
            <div className="bg-slate-50 px-4 py-2 border-b border-slate-100 text-[10px] font-black uppercase tracking-wider text-slate-450">
              Field: {r.field}
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100">
            <div className="bg-rose-50/20 p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-rose-500 mb-2 flex items-center gap-1">
                <span>− Current Staged</span>
              </p>
              <pre className="text-[11px] font-mono whitespace-pre-wrap text-rose-950/80 leading-relaxed max-h-48 overflow-y-auto custom-scrollbar">{r.before || '(empty)'}</pre>
            </div>
            <div className="bg-emerald-50/20 p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600 mb-2 flex items-center gap-1">
                <span>+ Draft Proposal</span>
              </p>
              <pre className="text-[11px] font-mono whitespace-pre-wrap text-emerald-950/85 leading-relaxed max-h-48 overflow-y-auto custom-scrollbar">{r.after}</pre>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function DraftModal({ draft, onClose, onSaved, onDeleted }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(draft.content, null, 2));
  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [copyLabel, setCopyLabel] = useState('Copy');
  const [error, setError] = useState(null);
  const [filePreview, setFilePreview] = useState(null); // null | 'loading' | {ok, ...} | {ok:false, error}
  const status = STATUS_INFO[draft.status] || STATUS_INFO.draft;
  const brandColor = GENERATOR_COLORS[draft.action_type] || '#6366f1';
  const [showDiff, setShowDiff] = useState(true);

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
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-md flex items-center justify-center p-4" onClick={onClose}>
      <div 
        className="bg-white/95 backdrop-blur-md rounded-3xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col border border-slate-200/60 overflow-hidden animate-slide-up" 
        onClick={(e) => e.stopPropagation()}
      >
        {/* Color stripe for branding */}
        <div className="h-1.5 shrink-0" style={{ background: `linear-gradient(to right, ${brandColor}, ${brandColor}44)` }} />

        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 bg-slate-50/20">
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-xl grid place-items-center text-sm shrink-0 shadow-sm border border-slate-150 bg-white"
              style={{ color: brandColor }}>
              <Sparkles size={14} />
            </span>
            <div>
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                {ACTION_LABELS[draft.action_type] || draft.action_type}
              </div>
              <div 
                className="text-xs font-black uppercase tracking-wide mt-1 px-2.5 py-0.5 rounded-full border w-fit"
                style={{ color: status.color, backgroundColor: status.bg, borderColor: status.border }}
              >
                {status.label}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full border border-slate-200/70 hover:border-slate-300 grid place-items-center text-slate-400 hover:text-slate-700 transition active:scale-95 shrink-0"
            aria-label="Close modal"
          >
            <X size={15} />
          </button>
        </div>

        {/* Error/Notice banners */}
        {draft.apply_error && (
          <div className="px-6 py-3 border-b border-slate-100 bg-rose-50 text-xs text-rose-700 leading-relaxed flex items-center gap-2">
            <AlertTriangle size={14} className="text-rose-500 shrink-0" />
            <span><span className="font-extrabold">Deployment Attempt Failed:</span> {draft.apply_error}</span>
          </div>
        )}

        {draft.stage_merge_url && (
          <div className="px-6 py-3 border-b border-slate-100 bg-indigo-50/30 flex items-center justify-between gap-3 text-xs">
            <a href={draft.stage_merge_url} target="_blank" rel="noopener noreferrer" className="font-bold text-indigo-600 hover:underline flex items-center gap-1">
              View merge commit on GitHub <ExternalLink size={12} />
            </a>
            <span className="font-extrabold text-emerald-600 flex items-center gap-1">
              <Check size={12} strokeWidth={3} /> Merged to stage
            </span>
          </div>
        )}

        {/* Modal Scrollable Content Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 custom-scrollbar">
          {editing ? (
            <div className="space-y-2">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 flex items-center justify-between">
                <span>Direct JSON Editor</span>
                <span className="text-rose-500">Caution: formatting errors will reject compile</span>
              </div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="w-full h-64 sm:h-96 max-h-[50vh] text-xs font-mono border border-slate-200 rounded-2xl p-4 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-400 bg-slate-950 text-slate-200 scrollbar-thin"
                spellCheck={false}
              />
            </div>
          ) : (
            <>
              {/* Draft Content Card Wrapper */}
              <div className="bg-slate-50/50 border border-slate-150 rounded-3xl p-5">
                <DraftPreview actionType={draft.action_type} content={draft.content}
                  onSelectTitle={draft.action_type === 'meta-title' && draft.status !== 'implemented' ? selectTitle : undefined} />
              </div>

              {/* GitHub File Diff Preview Section */}
              {draft.status !== 'implemented' && (
                <div className="mt-5 pt-5 border-t border-slate-100">
                  {draft.status === 'branch_pushed' && (
                    <div className="text-xs text-indigo-700 bg-indigo-50/60 border border-indigo-100/50 rounded-2xl p-4 mb-4 leading-relaxed flex items-start gap-2.5">
                      <GitBranch size={16} className="text-indigo-500 shrink-0 mt-0.5" />
                      <p>
                        This branch has been pushed to GitHub. Review the real file diff below. Merging this PR deploys it to staging and completes the pipeline in one step.
                      </p>
                    </div>
                  )}

                  {!filePreview && (
                    <button
                      type="button"
                      onClick={loadFilePreview}
                      className="text-[11px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl text-slate-650 hover:bg-slate-100 border border-slate-250 transition duration-150 active:scale-[0.98] shadow-sm flex items-center gap-1.5"
                    >
                      <GitBranch size={12} /> Show real file diff from GitHub
                    </button>
                  )}
                  {filePreview === 'loading' && (
                    <div className="text-xs text-slate-400 flex items-center gap-1.5 animate-pulse">
                      <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                      Fetching real git repository diff…
                    </div>
                  )}
                  {filePreview && filePreview !== 'loading' && (
                    <div className="space-y-3 mt-3">
                      <button 
                        type="button" 
                        onClick={() => setShowDiff(!showDiff)}
                        className="text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-indigo-650 hover:border-slate-350 transition duration-150 flex items-center gap-1 shadow-sm active:scale-95 focus:outline-none"
                      >
                        <span>{showDiff ? 'Hide File Diff' : 'Show File Diff'}</span>
                        {showDiff ? <ChevronUp size={10} strokeWidth={2.5} /> : <ChevronDown size={10} strokeWidth={2.5} />}
                      </button>
                      
                      {showDiff && (
                        filePreview.ok ? <FileDiffPreview result={filePreview} /> : (
                          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-2xl p-4 leading-relaxed flex items-center gap-2">
                            <AlertTriangle size={14} className="text-amber-500 shrink-0" />
                            <span>{filePreview.error}</span>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {error && (
            <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-2xl p-3 mt-3 flex items-center gap-2">
              <AlertTriangle size={14} className="text-rose-500 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-6 py-4 border-t border-slate-100 bg-slate-50/50 rounded-b-3xl">
          {draft.status !== 'implemented' ? (
            <button
              onClick={remove}
              className="text-[11px] font-black uppercase tracking-wider text-rose-500 hover:text-rose-700 flex items-center gap-1 px-2.5 py-2 rounded-lg hover:bg-rose-50/40 transition"
            >
              <Trash2 size={12} /> Discard Draft
            </button>
          ) : <span />}

          <div className="flex flex-wrap items-center justify-end gap-2 ml-auto">
            {editing ? (
              <>
                <button
                  onClick={() => setEditing(false)}
                  className="text-[11px] font-black uppercase tracking-wider px-3.5 py-2.5 rounded-xl text-slate-500 hover:bg-slate-100 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={saving}
                  className="text-[11px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-sm hover:shadow-indigo-500/15 disabled:opacity-60 flex items-center gap-1"
                  style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
                >
                  <Save size={12} /> {saving ? 'Saving…' : 'Save Draft'}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={copy}
                  className="text-[11px] font-black uppercase tracking-wider px-3.5 py-2.5 rounded-xl text-slate-600 hover:bg-slate-100 border border-slate-205 transition duration-150 shadow-sm active:scale-[0.98] flex items-center gap-1"
                >
                  <Copy size={12} /> {copyLabel}
                </button>

                {(draft.status === 'draft' || draft.status === 'edited') && (
                  <>
                    <button
                      onClick={startEdit}
                      className="text-[11px] font-black uppercase tracking-wider px-3.5 py-2.5 rounded-xl text-indigo-600 hover:bg-indigo-50 border border-indigo-200 transition duration-150 shadow-sm active:scale-[0.98] flex items-center gap-1"
                    >
                      <Edit3 size={12} /> Edit
                    </button>
                    <button
                      onClick={() => transition(() => api.actionCenter.submitDraft(draft.id))}
                      disabled={transitioning}
                      className="text-[11px] font-black uppercase tracking-wider px-4.5 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md shadow-indigo-100 hover:shadow-indigo-500/15 disabled:opacity-60 flex items-center gap-1"
                      style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
                    >
                      <Check size={12} strokeWidth={2.5} /> {transitioning ? 'Submitting…' : 'Submit for Approval'}
                    </button>
                  </>
                )}

                {draft.status === 'submitted_for_approval' && (
                  <button
                    onClick={() => transition(() => api.actionCenter.approveDraft(draft.id))}
                    disabled={transitioning}
                    className="text-[11px] font-black uppercase tracking-wider px-4.5 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md shadow-emerald-100 hover:shadow-emerald-500/15 disabled:opacity-60 flex items-center gap-1"
                    style={{ background: 'linear-gradient(135deg,#10b981,#059669)' }}
                  >
                    <Check size={12} strokeWidth={2.5} /> {transitioning ? 'Approving…' : 'Approve'}
                  </button>
                )}

                {draft.status === 'approved' && (
                  <>
                    {!MERGE_MANDATORY_TYPES.includes(draft.action_type) && (
                      <button
                        onClick={() => transition(() => api.actionCenter.implementDraft(draft.id))}
                        disabled={transitioning}
                        className="text-[11px] font-black uppercase tracking-wider px-3.5 py-2.5 rounded-xl text-slate-500 hover:bg-slate-100 border border-slate-200 disabled:opacity-60 transition"
                      >
                        Mark Implemented manually
                      </button>
                    )}
                    <button
                      onClick={() => transition(() => api.actionCenter.pushBranch(draft.id))}
                      disabled={transitioning}
                      className="text-[11px] font-black uppercase tracking-wider px-4.5 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md hover:shadow-indigo-500/15 disabled:opacity-60 flex items-center gap-1"
                      style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
                    >
                      <GitBranch size={12} /> {transitioning ? 'Pushing…' : 'Push Branch'}
                    </button>
                  </>
                )}

                {draft.status === 'branch_pushed' && (
                  <>
                    <span
                      className="text-[10px] font-mono text-slate-400 truncate max-w-[140px] hidden sm:inline-block bg-slate-100 rounded-lg px-2 py-1"
                      title={draft.branch_name}
                    >
                      {draft.branch_name}
                    </span>
                    <button
                      onClick={() => transition(() => api.actionCenter.mergeToStage(draft.id))}
                      disabled={transitioning}
                      className="text-[11px] font-black uppercase tracking-wider px-4.5 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md hover:shadow-indigo-500/15 disabled:opacity-60 flex items-center gap-1"
                      style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
                    >
                      <Check size={12} strokeWidth={2.5} /> {transitioning ? 'Merging…' : 'Merge to Stage'}
                    </button>
                  </>
                )}

                {draft.status === 'merged_to_stage' && (
                  <>
                    <span className="text-[10px] font-semibold text-slate-400 max-w-[200px] leading-snug">
                      Live on staging.
                    </span>
                    <button
                      onClick={() => transition(() => api.actionCenter.implementDraft(draft.id))}
                      disabled={transitioning}
                      className="text-[11px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md hover:shadow-emerald-500/15 disabled:opacity-60 shrink-0"
                      style={{ background: 'linear-gradient(135deg,#10b981,#059669)' }}
                    >
                      Mark Implemented
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
