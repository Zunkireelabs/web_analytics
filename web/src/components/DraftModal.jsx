import { useState } from 'react';
import { api } from '../api.js';
import DraftPreview from './DraftPreview.jsx';

const ACTION_LABELS = {
  'meta-title': 'Meta Title & Description', faq: 'FAQ', schema: 'Schema Markup',
  'internal-links': 'Internal Links', 'blog-outline': 'Blog Outline',
  'landing-page': 'Landing Page', translation: 'Translation',
};

// Preview / Copy / Edit / Save Draft for one draft. No publish action exists
// here — Save Draft only ever writes back to the drafts table.
export default function DraftModal({ draft, onClose, onSaved, onDeleted }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(draft.content, null, 2));
  const [saving, setSaving] = useState(false);
  const [copyLabel, setCopyLabel] = useState('Copy');
  const [error, setError] = useState(null);

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
            <div className="text-sm font-bold text-slate-900 mt-0.5">
              {draft.status === 'edited' ? 'Edited draft' : 'Draft'} · never published
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {editing ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full h-96 text-xs font-mono border border-slate-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              spellCheck={false}
            />
          ) : (
            <DraftPreview actionType={draft.action_type} content={draft.content} />
          )}
          {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
          <button onClick={remove} className="text-xs font-semibold text-rose-500 hover:text-rose-700">Discard</button>
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
                <button onClick={startEdit} className="text-xs font-semibold px-3.5 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">Edit</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
