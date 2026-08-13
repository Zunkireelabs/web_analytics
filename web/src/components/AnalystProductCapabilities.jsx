import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Layers, Plus, Loader2, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';

const CATEGORY_OPTIONS = [
  'CRM', 'Booking', 'Appointment Management', 'Billing/Payments', 'Customer Management', 'Operations', 'Other',
];

// Ground truth for what this site's product actually does — read by
// classifyGapRelevance (server/agents/lib/analyst-seo-mapping.js) before a
// keyword gap is routed to a generator, so a "spa billing software" search
// only becomes a landing page if a capability like this genuinely exists.
// Every row added here is 'verified' immediately (staff-asserted, not an
// agent's guess) — there is no agent-proposal writer yet, so this list is
// authoritative until/unless that's built.
export default function AnalystProductCapabilities({ clientId }) {
  const [capabilities, setCapabilities] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState({ name: '', category: CATEGORY_OPTIONS[0], description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const load = () => {
    api.keywords.capabilities(clientId)
      .then(setCapabilities)
      .catch((e) => setError(e.message || 'Failed to load product capabilities.'));
  };

  useEffect(() => {
    setCapabilities(null);
    setError(null);
    setExpanded(false);
    load();
  }, [clientId]);

  const submit = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.keywords.addCapability(clientId, {
        name,
        category: form.category,
        description: form.description.trim() || null,
      });
      setForm({ name: '', category: CATEGORY_OPTIONS[0], description: '' });
      load();
    } catch (e) {
      setError(e.message || 'Could not add that capability.');
    } finally {
      setSaving(false);
    }
  };

  const loading = capabilities === null;

  return (
    <div className="an-panel p-5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 cursor-pointer"
      >
        <div className="w-8 h-8 rounded-xl grid place-items-center bg-indigo-500/10 border border-indigo-500/25 text-indigo-600 shrink-0">
          <Layers size={15} />
        </div>
        <div className="flex-1 min-w-0 text-left">
          <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">Product Capabilities</h2>
          <p className="text-[11px] font-medium text-slate-500">
            What this product actually does — used to route keyword gaps to the right asset, not just a blog
          </p>
        </div>
        {!loading && (
          <span className="an-chip an-chip-slate shrink-0">{capabilities.length}</span>
        )}
        {expanded ? <ChevronUp size={14} className="text-slate-400 shrink-0" /> : <ChevronDown size={14} className="text-slate-400 shrink-0" />}
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          {error && (
            <p className="text-[11px] font-semibold text-rose-600 flex items-center gap-1.5">
              <AlertTriangle size={11} className="shrink-0" />
              {error}
            </p>
          )}

          {loading ? (
            <div className="space-y-2">
              {[0, 1].map((i) => <div key={i} className="h-11 rounded-xl bg-slate-200/50 animate-pulse" />)}
            </div>
          ) : capabilities.length === 0 ? (
            <p className="text-xs font-medium text-slate-500 bg-slate-100/60 border border-slate-200 rounded-xl px-4 py-3">
              Nothing added yet. A keyword gap can only be routed to a landing page instead of a generic blog once
              there's something real here to check it against — add what this product actually does below.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {capabilities.map((c) => (
                <div key={c.id} className="rounded-xl border border-slate-200 bg-slate-100/40 p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-black text-slate-800">{c.name}</span>
                    {c.category && <span className="an-chip an-chip-violet">{c.category}</span>}
                  </div>
                  {c.description && (
                    <p className="text-[11px] font-medium text-slate-500 mt-1 line-clamp-2">{c.description}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          <form onSubmit={submit} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1">
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Booking Engine"
              maxLength={120}
              disabled={saving}
              className="an-input flex-1 text-[11px] font-semibold py-2.5"
            />
            <select
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              disabled={saving}
              className="an-input text-[11px] font-bold py-2.5 pr-8 cursor-pointer"
            >
              {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Short description (optional)"
              maxLength={300}
              disabled={saving}
              className="an-input flex-[1.5] text-[11px] font-semibold py-2.5"
            />
            <button
              type="submit"
              disabled={saving || !form.name.trim()}
              className="an-grad-btn text-[11px] font-bold px-3 py-2.5 rounded-xl text-white shrink-0 flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
              Add
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
