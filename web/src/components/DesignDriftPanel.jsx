import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../api.js';

const fieldCls = 'w-full text-[11px] font-bold text-slate-700 border border-slate-200/80 rounded-lg px-2.5 py-1.5 bg-white disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF]';
const labelCls = 'block text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1';

const ACTION_TYPES = [
  { value: 'faq', label: 'FAQ accordion' },
  { value: 'expand-content', label: 'Expand content' },
  { value: 'internal-links', label: 'Internal links' },
];

// Manual entry point for implementers/lib/design-drift.js's check +
// regeneration, for a staff member who's noticed (e.g. a page in Action
// Center failed to apply with reason 'template-stale', or a site redesign
// they know about) rather than every draft attempt surfacing its own retry
// UI — a wrong auto-extracted template affects every future draft of this
// action type sitewide, so this always requires a real page URL to check
// against and an explicit Save click, never an automatic apply.
export default function DesignDriftPanel({ clientId }) {
  const [actionType, setActionType] = useState('faq');
  const [pageUrl, setPageUrl] = useState('');
  const [checkState, setCheckState] = useState('idle'); // idle | running | error
  const [checkError, setCheckError] = useState(null);
  const [result, setResult] = useState(null); // { stale, message? } | { stale: true, missingClasses, oldTemplate, proposedTemplate }
  const [saveState, setSaveState] = useState('idle'); // idle | running | done | error
  const [saveError, setSaveError] = useState(null);

  const check = async () => {
    if (!pageUrl.trim()) { setCheckError('Enter a real, live page URL that uses this component.'); return; }
    setCheckState('running');
    setCheckError(null);
    setResult(null);
    setSaveState('idle');
    try {
      const data = await api.clients.regenerateComponentTemplate(clientId, actionType, pageUrl.trim());
      setResult(data);
      setCheckState('idle');
    } catch (err) {
      setCheckError(err.message || 'Could not check this page.');
      setCheckState('error');
    }
  };

  const save = async () => {
    setSaveState('running');
    setSaveError(null);
    try {
      await api.clients.confirmComponentTemplate(clientId, actionType, result.proposedTemplate);
      setSaveState('done');
    } catch (err) {
      setSaveError(err.message || 'Could not save.');
      setSaveState('error');
    }
  };

  return (
    <div className="rounded-2xl bg-amber-500/[0.04] border border-amber-500/15 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <AlertTriangle size={11} className="text-amber-500 shrink-0" />
        <p className="text-[10px] font-bold text-slate-600 leading-relaxed">
          Checks whether a stored component template (FAQ/expand-content/internal-links) still matches this site's
          real, live design — the CSS classes it uses may no longer exist if the site was redesigned since the
          template was captured. Enter a real page currently using that component.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Component</label>
          <select className={fieldCls} disabled={checkState === 'running'} value={actionType} onChange={(e) => { setActionType(e.target.value); setResult(null); }}>
            {ACTION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Live page URL</label>
          <input
            type="text" className={fieldCls} disabled={checkState === 'running'}
            value={pageUrl} onChange={(e) => setPageUrl(e.target.value)}
            placeholder="https://example.com/contact/"
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button" onClick={check} disabled={checkState === 'running'}
          className="text-[10px] font-black uppercase tracking-wider px-4 py-2 rounded-xl text-white transition disabled:opacity-50 active:scale-95"
          style={{ background: 'linear-gradient(135deg,#f59e0b,#d97706)' }}
        >
          {checkState === 'running' ? 'Checking…' : 'Check Current Design'}
        </button>
        {checkError && <span className="text-[10px] font-bold text-rose-600">{checkError}</span>}
      </div>

      {result && !result.stale && (
        <div className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2">
          {result.message || 'Still matches the live design — nothing to update.'}
        </div>
      )}

      {result?.stale && (
        <div className="space-y-2">
          <div className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
            Design changed — classes no longer live: {result.missingClasses.join(', ')}. Review the proposed replacement below before saving.
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Current (stale) template</label>
              <pre className="text-[9px] font-mono bg-slate-50 border border-slate-200 rounded-lg p-2 overflow-x-auto max-h-40">{JSON.stringify(result.oldTemplate, null, 2)}</pre>
            </div>
            <div>
              <label className={labelCls}>Proposed (from current live design)</label>
              <pre className="text-[9px] font-mono bg-slate-50 border border-slate-200 rounded-lg p-2 overflow-x-auto max-h-40">{JSON.stringify(result.proposedTemplate, null, 2)}</pre>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button" onClick={save} disabled={saveState === 'running' || saveState === 'done'}
              className="text-[10px] font-black uppercase tracking-wider px-4 py-2 rounded-xl text-white transition disabled:opacity-50 active:scale-95"
              style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
            >
              {saveState === 'running' ? 'Saving…' : saveState === 'done' ? 'Saved ✓' : 'Save This Template'}
            </button>
            {saveState === 'error' && <span className="text-[10px] font-bold text-rose-600">{saveError}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
